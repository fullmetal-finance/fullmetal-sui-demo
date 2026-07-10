/**
 * On-chain smoke of the EWMA vol loop (post-upgrade): create a scratch
 * institution, deposit + rehypothecate DBUSDC, drive the demo "flash crash"
 * price path through `push_price_v2`, and verify against live testnet state:
 *
 *   tick 4  (−20% gap)  → trigger LATCHES on-chain → `recall_on_trigger` pulls
 *                         the supplied collateral back (permissionless)
 *   ticks 8–10 (calm)   → release_progress counts 1,2 → 3rd print auto-UNLATCHES
 *
 * Leaves SPCX reset ($185, untriggered, vol re-seeded). ~15 txs, ops key.
 * Usage: npx tsx vol-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

const PKG = '0xf8b57f09dfe5e59fcc176110c8f15cf96b27f6f23be8a4db959529d896635a4a';
const RISK_ORACLE = '0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd';
const ORACLE_ADMIN_CAP = '0x33adac6f64ae3ecb1af395de98f9a4f0708d1d97f4848a32dc428a7b9e651b87';
const KEEPER_CAP = '0x3767fad45d82370652ccec28025f83545833ee7f2e1567042b7f5067a3ab1e3a';
const HANDLE_REGISTRY = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const MARGIN_POOL = '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d';
const MARGIN_REGISTRY = '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75';
const CLOCK = '0x6';
const SYMBOL = 'SPCX';

// the demo flash-crash path (validated against the Move integer math offline):
// latch expected on tick 4, auto-release expected on tick 10.
const PATH = [184.6, 185.3, 184.9, 148.0, 152.5, 147.8, 151.2, 149.6, 150.4, 150.1, 150.6];
const EXPECT_LATCH_TICK = 4;
const EXPECT_RELEASE_TICK = 10;

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

async function run(label: string, build: (tx: Transaction) => void) {
  const tx = new Transaction();
  build(tx);
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`${label} FAILED: ${JSON.stringify(res.effects?.status)}\n  ${res.digest}`);
  }
  return res;
}

function created(res: { objectChanges?: unknown[] | null }, typeIncludes: string): string {
  const c = (res.objectChanges ?? []).find(
    (o) => (o as { type?: string }).type === 'created' && ((o as { objectType?: string }).objectType ?? '').includes(typeIncludes),
  );
  if (!c) throw new Error('no created object matching ' + typeIncludes);
  return (c as { objectId: string }).objectId;
}

/** batch status read: [price, triggered, vol_bps, release_progress, rehypothecated] */
async function status(inst: string) {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::oracle::price`, arguments: [tx.object(RISK_ORACLE), tx.pure.string(SYMBOL)] });
  tx.moveCall({ target: `${PKG}::oracle::is_triggered`, arguments: [tx.object(RISK_ORACLE), tx.pure.string(SYMBOL)] });
  tx.moveCall({ target: `${PKG}::oracle::vol_bps`, arguments: [tx.object(RISK_ORACLE), tx.pure.string(SYMBOL)] });
  tx.moveCall({ target: `${PKG}::oracle::release_progress`, arguments: [tx.object(RISK_ORACLE), tx.pure.string(SYMBOL)] });
  tx.moveCall({ target: `${PKG}::institution::rehypothecated_of`, typeArguments: [DBUSDC], arguments: [tx.object(inst)] });
  const r = await client.devInspectTransactionBlock({ sender: me, transactionBlock: tx });
  const u64 = (i: number) => {
    const b = (r.results?.[i]?.returnValues?.[0]?.[0] ?? []) as number[];
    let v = 0n;
    for (let j = b.length - 1; j >= 0; j--) v = (v << 8n) + BigInt(b[j]);
    return v;
  };
  const boolAt = (i: number) => ((r.results?.[i]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
  return {
    mark: Number(u64(0)) / 1e6,
    triggered: boolAt(1),
    sigma: Number(u64(2)),
    releaseCount: Number(u64(3)),
    rehypothecated: Number(u64(4)) / 1e6,
  };
}

async function main() {
  console.log('— EWMA vol loop smoke (testnet, real DBUSDC) —\n');

  // 0. fresh stage
  const handle = `fmsmoke${Date.now().toString(36)}`;
  const r1 = await run('create institution', (tx) => {
    const cap = tx.moveCall({
      target: `${PKG}::institution::create_institution`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(HANDLE_REGISTRY), tx.pure.string(handle)],
    });
    tx.transferObjects([cap], me);
  });
  const inst = created(r1, '::institution::Institution<');
  const adminCap = created(r1, '::institution::AdminCap');
  console.log(`✓ institution ${inst.slice(0, 10)}… (@${handle})`);

  await run('deposit 10 + rehypothecate 5 DBUSDC', (tx) => {
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), coinWithBalance({ type: DBUSDC, balance: 10_000_000n })],
    });
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(5_000_000n), tx.object(CLOCK)],
    });
  });
  let s = await status(inst);
  console.log(`✓ rehypothecated: $${s.rehypothecated} | σ ${s.sigma} bps | triggered ${s.triggered}\n`);
  if (s.rehypothecated !== 5) throw new Error('rehypothecation mirror wrong');

  // 1. drive the path
  let latchTick = -1;
  let releaseTick = -1;
  for (let i = 0; i < PATH.length; i++) {
    const tick = i + 1;
    const price = BigInt(Math.round(PATH[i] * 1e6));
    await run(`tick ${tick}`, (tx) => {
      tx.moveCall({
        target: `${PKG}::oracle::push_price_v2`,
        arguments: [tx.object(RISK_ORACLE), tx.object(KEEPER_CAP), tx.pure.string(SYMBOL), tx.pure.u64(price), tx.object(CLOCK)],
      });
    });
    const before = s;
    s = await status(inst);
    console.log(
      `tick ${String(tick).padStart(2)}: $${s.mark.toFixed(2).padStart(7)} | σ ${String(s.sigma).padStart(4)} bps | ` +
      `${s.triggered ? 'LATCHED' : 'calm   '} | release ${s.releaseCount}/3 | pool $${s.rehypothecated}`,
    );
    // first latch → permissionless recall (what the keeper/server does live)
    if (s.triggered && !before.triggered && latchTick < 0) {
      latchTick = tick;
      await run('recall_on_trigger', (tx) => {
        tx.moveCall({
          target: `${PKG}::rehypo::recall_on_trigger`,
          typeArguments: [DBUSDC],
          arguments: [tx.object(inst), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.object(RISK_ORACLE), tx.pure.string(SYMBOL), tx.object(CLOCK)],
        });
      });
      s = await status(inst);
      console.log(`        ⚠ trigger latched → recalled; pool now $${s.rehypothecated}`);
      if (s.rehypothecated !== 0) throw new Error('recall did not empty the pool position');
    }
    if (!s.triggered && before.triggered && releaseTick < 0) {
      releaseTick = tick;
      console.log('        ✓ volatility subsided → latch auto-released on-chain');
    }
  }

  // 2. redeposit on release (the desk's own move in the live demo)
  await run('redeposit after release', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(5_000_000n), tx.object(CLOCK)],
    });
  });
  s = await status(inst);
  console.log(`✓ redeposited; pool $${s.rehypothecated}\n`);

  // 3. clean the stage: recall the smoke funds + withdraw back to ops, reset feed
  await run('cleanup: recall + withdraw + reset feed', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::recall`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(5_000_000n), tx.object(CLOCK)],
    });
    const c = tx.moveCall({
      target: `${PKG}::institution::withdraw_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.pure.u64(9_900_000n)],
    });
    tx.transferObjects([c], me);
    tx.moveCall({
      target: `${PKG}::oracle::disable_vol`,
      arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)],
    });
    tx.moveCall({
      target: `${PKG}::oracle::push_price`,
      arguments: [tx.object(RISK_ORACLE), tx.object(KEEPER_CAP), tx.pure.string(SYMBOL), tx.pure.u64(185_000_000n), tx.object(CLOCK)],
    });
    tx.moveCall({
      target: `${PKG}::oracle::clear_trigger`,
      arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)],
    });
    tx.moveCall({
      target: `${PKG}::oracle::enable_vol`,
      arguments: [
        tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL),
        tx.pure.u64(150n), tx.pure.u64(6_000n), tx.pure.u64(400n), tx.pure.u64(800n), tx.pure.u64(7_000n), tx.pure.u64(3n),
      ],
    });
  });

  const verdictLatch = latchTick === EXPECT_LATCH_TICK ? '✓' : '✗';
  const verdictRelease = releaseTick === EXPECT_RELEASE_TICK ? '✓' : '✗';
  console.log(`${verdictLatch} latch tick:   ${latchTick} (expected ${EXPECT_LATCH_TICK})`);
  console.log(`${verdictRelease} release tick: ${releaseTick} (expected ${EXPECT_RELEASE_TICK})`);
  if (latchTick !== EXPECT_LATCH_TICK || releaseTick !== EXPECT_RELEASE_TICK) process.exit(1);
  console.log('\nPASS — on-chain EWMA behavior matches the offline simulation.');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
