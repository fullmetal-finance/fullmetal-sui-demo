/**
 * Post-rehearsal sweep: recover DBUSDC from the throwaway smoke/drill desks
 * back to the ops wallet, and skim maker desks down to a $20 quoting float.
 *
 * For every institution whose AdminCap the ops key holds:
 *   - handle starts with fmsmoke/fmdrill/fmdemo → recall all rehypothecated
 *     collateral, then withdraw everything unreserved
 *   - maker desks (Cumberland/Galaxy/Wintermute) → withdraw down to $20
 *
 * Usage: npx tsx sweep-desks.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

const PKG = '0xf8b57f09dfe5e59fcc176110c8f15cf96b27f6f23be8a4db959529d896635a4a';
const ORIGINAL_PKG = '0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const MARGIN_POOL = '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d';
const MARGIN_REGISTRY = '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75';
const CLOCK = '0x6';

const SCRATCH = /^fm(smoke|drill|demo|dust)/;
const MAKER_FLOAT = 20_000_000n; // keep $20 in each maker desk

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
  throw new Error('no key');
}

const client = new SuiJsonRpcClient({ url: TESTNET_JSONRPC_URL });
const kp = keypair();
const me = kp.toSuiAddress();

async function main() {
  // all (institution, adminCap) pairs the ops key controls
  const caps: { inst: string; cap: string }[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await client.getOwnedObjects({
      owner: me,
      filter: { StructType: `${ORIGINAL_PKG}::institution::AdminCap` },
      options: { showContent: true },
      cursor: cursor ?? undefined,
    });
    for (const o of page.data) {
      const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
      if (iid) caps.push({ inst: iid, cap: o.data!.objectId });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  let swept = 0n;
  for (const { inst, cap } of caps) {
    const o = await client.getObject({ id: inst, options: { showContent: true } });
    const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f) continue;
    const handle = String(f.handle ?? '');
    const treasury = BigInt(f.treasury ?? '0');
    const reserved = BigInt(f.reserved ?? '0');
    const rehyp = BigInt(f.rehypothecated ?? '0');
    const isScratch = SCRATCH.test(handle);
    const isMaker = ['cumberland', 'galaxy', 'wintermute'].some((m) => handle.includes(m));
    if (!isScratch && !isMaker) continue;

    const tx = new Transaction();
    let acted = false;
    if (isScratch && rehyp > 0n) {
      tx.moveCall({
        target: `${PKG}::rehypo::recall`,
        typeArguments: [DBUSDC],
        arguments: [tx.object(inst), tx.object(cap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(rehyp), tx.object(CLOCK)],
      });
      acted = true;
    }
    const liquidAfter = treasury + (isScratch ? rehyp : 0n);
    const equity = treasury + rehyp;
    const available = equity > reserved ? equity - reserved : 0n;
    const floor = isMaker ? MAKER_FLOAT : 0n;
    const target = available > floor ? available - floor : 0n;
    const amount = target < liquidAfter ? target : liquidAfter;
    if (amount > 100_000n) {
      const c = tx.moveCall({
        target: `${PKG}::institution::withdraw_treasury`,
        typeArguments: [DBUSDC],
        arguments: [tx.object(inst), tx.object(cap), tx.pure.u64(amount)],
      });
      tx.transferObjects([c], me);
      acted = true;
    }
    if (!acted) continue;
    const res = await client.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
    await client.waitForTransaction({ digest: res.digest });
    const ok = res.effects?.status.status === 'success';
    console.log(`${ok ? '✓' : '✗'} @${handle} ${inst.slice(0, 10)}… swept $${Number(amount) / 1e6}${rehyp > 0n && isScratch ? ` (incl. $${Number(rehyp) / 1e6} recalled)` : ''}`);
    if (ok) swept += amount;
  }
  const bal = await client.getBalance({ owner: me, coinType: DBUSDC });
  console.log(`\nswept ≈ $${Number(swept) / 1e6} · ops DBUSDC now $${Number(bal.totalBalance) / 1e6}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
