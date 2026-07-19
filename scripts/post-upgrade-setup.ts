/**
 * Post-upgrade setup: arm the EWMA volatility layer on the SPCX feed and reset
 * the feed to its nominal mark, untriggered — the clean stage for the demo.
 *
 * Calibration (why λ=0.60, not the production 0.94): the demo pushes a print
 * every ~1.2s, so the estimator's half-life must be a handful of PRINTS, not
 * days. With λ=0.60 a −20% shock latches at z≈13σ, σ then decays through the
 * regime band in ~4 prints, and the 3-print release deadband counts down on
 * the calm tail — the whole latch→release arc fits a ~15-tick scenario.
 * `retune_vol` can change any of this later without redeploying.
 *
 * Usage: npx tsx post-upgrade-setup.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

// current package (post-upgrade) — new oracle entry points live here
const PKG = '0x141f7de4ea75cde406d424a0669e17e34352ef9fd594bcae6f0139ef6dd74700';
const RISK_ORACLE = '0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd';
const ORACLE_ADMIN_CAP = '0x33adac6f64ae3ecb1af395de98f9a4f0708d1d97f4848a32dc428a7b9e651b87';
const KEEPER_CAP = '0x3767fad45d82370652ccec28025f83545833ee7f2e1567042b7f5067a3ab1e3a';
const CLOCK = '0x6';

const SYMBOL = 'SPCX';
const NOMINAL = 148_000_000n; // ≈ real SPCX (Nasdaq, July 2026)

// EWMA calibration (demo cadence — see header)
const SEED_SIGMA_BPS = 150n; // 1.5%/print warm start
const LAMBDA_BPS = 6_000n; // λ = 0.60 (fast half-life, ~1 print ≈ 1.2s)
const Z_LATCH_X100 = 400n; // 4.0σ shock latch
const SIGMA_CEIL_BPS = 800n; // 8%/print regime latch
const THETA_REL_BPS = 7_000n; // release only below 0.7·ceil = 560 bps
const RELEASE_NEEDED = 3n; // 3 consecutive in-band prints unlatch

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

async function run(label: string, build: (tx: Transaction) => void) {
  const tx = new Transaction();
  build(tx);
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`${label} FAILED: ${JSON.stringify(res.effects?.status)}\n  ${res.digest}`);
  }
  console.log(`✓ ${label}  ${res.digest}`);
}

async function readU64(target: string, str?: string): Promise<bigint> {
  const tx = new Transaction();
  const args = [tx.object(RISK_ORACLE)] as ReturnType<Transaction['object']>[];
  tx.moveCall({ target, arguments: str ? [tx.object(RISK_ORACLE), tx.pure.string(str)] : args });
  const r = await client.devInspectTransactionBlock({ sender: RISK_ORACLE, transactionBlock: tx });
  const bytes = (r.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[];
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) + BigInt(bytes[i]);
  return v;
}

async function readBool(target: string): Promise<boolean> {
  const tx = new Transaction();
  tx.moveCall({ target, arguments: [tx.object(RISK_ORACLE), tx.pure.string(SYMBOL)] });
  const r = await client.devInspectTransactionBlock({ sender: RISK_ORACLE, transactionBlock: tx });
  return ((r.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
}

async function main() {
  console.log(`package: ${PKG}`);

  const hasVol = await readBool(`${PKG}::oracle::has_vol`);
  console.log(`SPCX has_vol: ${hasVol}`);

  // (re-)arm the vol layer from a clean seed, and reset the feed in one tx:
  // push the nominal mark (v2 keeps EWMA coherent) then clear any stale latch.
  await run('reset SPCX + (re)arm EWMA vol', (tx) => {
    if (hasVol) {
      tx.moveCall({
        target: `${PKG}::oracle::disable_vol`,
        arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)],
      });
    }
    tx.moveCall({
      target: `${PKG}::oracle::push_price`,
      arguments: [tx.object(RISK_ORACLE), tx.object(KEEPER_CAP), tx.pure.string(SYMBOL), tx.pure.u64(NOMINAL), tx.object(CLOCK)],
    });
    tx.moveCall({
      target: `${PKG}::oracle::clear_trigger`,
      arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)],
    });
    tx.moveCall({
      target: `${PKG}::oracle::enable_vol`,
      arguments: [
        tx.object(RISK_ORACLE),
        tx.object(ORACLE_ADMIN_CAP),
        tx.pure.string(SYMBOL),
        tx.pure.u64(SEED_SIGMA_BPS),
        tx.pure.u64(LAMBDA_BPS),
        tx.pure.u64(Z_LATCH_X100),
        tx.pure.u64(SIGMA_CEIL_BPS),
        tx.pure.u64(THETA_REL_BPS),
        tx.pure.u64(RELEASE_NEEDED),
      ],
    });
  });

  const mark = await readU64(`${PKG}::oracle::price`, SYMBOL);
  const vol = await readU64(`${PKG}::oracle::vol_bps`, SYMBOL);
  const triggered = await readBool(`${PKG}::oracle::is_triggered`);
  console.log(`SPCX mark: $${Number(mark) / 1e6} | σ: ${vol} bps | triggered: ${triggered}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
