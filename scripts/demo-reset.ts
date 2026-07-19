/**
 * One-command clean stage for a demo run:
 *   1. SPCX feed → $148, trigger cleared, EWMA re-seeded (σ=150bps, λ=0.60)
 *   2. prints ops balances (SUI gas + DBUSDC for the faucet/makers)
 *   3. verifies the three maker desks still hold Admin+Trader caps
 *   4. prints the RPC endpoints in use and a pre-flight checklist
 *
 * Usage: npx tsx demo-reset.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

const PKG = '0x141f7de4ea75cde406d424a0669e17e34352ef9fd594bcae6f0139ef6dd74700';
const RISK_ORACLE = '0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd';
const ORACLE_ADMIN_CAP = '0x33adac6f64ae3ecb1af395de98f9a4f0708d1d97f4848a32dc428a7b9e651b87';
const KEEPER_CAP = '0x3767fad45d82370652ccec28025f83545833ee7f2e1567042b7f5067a3ab1e3a';
const CLOCK = '0x6';
const SYMBOL = 'SPCX';
const NOMINAL = 148_000_000n; // ≈ real SPCX (Nasdaq, July 2026)
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';

// must match frontend/lib/fullmetal.ts SPCX_VOL + post-upgrade-setup.ts
const VOL = { seed: 150n, lambda: 6_000n, z: 400n, ceil: 800n, theta: 7_000n, n: 3n };

// demo maker desks (api/makers): Cumberland / Galaxy / Wintermute
const MAKER_PREFIXES = ['0xf6de982c', '0x31089de7', '0xfb4db2ec'];

function keypair(): Ed25519Keypair {
  const cfg = join(homedir(), '.sui', 'sui_config');
  const addr =
    process.env.SUI_ADDRESS ??
    readFileSync(join(cfg, 'client.yaml'), 'utf8').match(/active_address:\s*"?(0x[0-9a-fA-F]+)"?/)?.[1];
  for (const b64 of JSON.parse(readFileSync(join(cfg, 'sui.keystore'), 'utf8')) as string[]) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error('no key for ' + addr);
}

const client = new SuiJsonRpcClient({ url: TESTNET_JSONRPC_URL });
const kp = keypair();
const me = kp.toSuiAddress();

async function readBool(target: string): Promise<boolean> {
  const tx = new Transaction();
  tx.moveCall({ target, arguments: [tx.object(RISK_ORACLE), tx.pure.string(SYMBOL)] });
  const r = await client.devInspectTransactionBlock({ sender: RISK_ORACLE, transactionBlock: tx });
  return ((r.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
}

async function main() {
  console.log('— demo reset —');
  console.log(`rpc: ${TESTNET_JSONRPC_URL}`);

  // 1. reset the feed atomically
  const hasVol = await readBool(`${PKG}::oracle::has_vol`);
  const tx = new Transaction();
  if (hasVol) {
    tx.moveCall({ target: `${PKG}::oracle::disable_vol`, arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)] });
  }
  tx.moveCall({ target: `${PKG}::oracle::push_price`, arguments: [tx.object(RISK_ORACLE), tx.object(KEEPER_CAP), tx.pure.string(SYMBOL), tx.pure.u64(NOMINAL), tx.object(CLOCK)] });
  tx.moveCall({ target: `${PKG}::oracle::clear_trigger`, arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)] });
  tx.moveCall({
    target: `${PKG}::oracle::enable_vol`,
    arguments: [
      tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL),
      tx.pure.u64(VOL.seed), tx.pure.u64(VOL.lambda), tx.pure.u64(VOL.z), tx.pure.u64(VOL.ceil), tx.pure.u64(VOL.theta), tx.pure.u64(VOL.n),
    ],
  });
  const res = await client.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') throw new Error('reset failed: ' + JSON.stringify(res.effects?.status));
  console.log(`✓ SPCX → $148, untriggered, EWMA re-seeded (σ 150 bps, λ 0.60)  ${res.digest}`);

  // 2. ops balances
  const [sui, dbusdc] = await Promise.all([
    client.getBalance({ owner: me }),
    client.getBalance({ owner: me, coinType: DBUSDC }),
  ]);
  const suiBal = Number(sui.totalBalance) / 1e9;
  const dbBal = Number(dbusdc.totalBalance) / 1e6;
  console.log(`${suiBal >= 1 ? '✓' : '✗'} ops SUI:    ${suiBal.toFixed(2)} (keeper gas — want ≥ 1)`);
  console.log(`${dbBal >= 150 ? '✓' : '✗'} ops DBUSDC: ${dbBal.toFixed(2)} (faucet + makers — want ≥ 150/run; top up: npx tsx swap-dbusdc.ts 300)`);

  // 3. maker desks
  let cursor: string | null | undefined = null;
  const owned: string[] = [];
  do {
    const page = await client.getOwnedObjects({
      owner: me,
      filter: { StructType: `0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf::institution::AdminCap` },
      options: { showContent: true },
      cursor: cursor ?? undefined,
    });
    for (const o of page.data) {
      const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
      if (iid) owned.push(iid);
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  for (const p of MAKER_PREFIXES) {
    const hit = owned.find((i) => i.startsWith(p));
    console.log(`${hit ? '✓' : '✗'} maker desk ${p}… ${hit ? 'ready' : 'MISSING'}`);
  }

  console.log(`
pre-flight:
  [ ] cd frontend && npm run dev          (http://localhost:3000)
  [ ] sign in with the demo Google account; institution loads
  [ ] Load funds $42 → broadcast SPCX RFQ (IM ≥ 5% of notional, default $8) → accept best quote
  [ ] optional drill: New OTC → Direct to "cumberland", 1 SPCX long — makers auto-accept? NO:
      run  npx tsx accept-direct.ts <offerId>  after proposing (see DEMO.md)
  [ ] Collateral manager: IM auto-deploys on accept (IM-only policy); rebalance across venues if desired
  [ ] ▶ Start live market → let it tick → 💥 Crash — latch → margin call → auto-cure → release → redeposit
`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
