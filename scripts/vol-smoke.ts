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

const PKG = '0x141f7de4ea75cde406d424a0669e17e34352ef9fd594bcae6f0139ef6dd74700';
const RISK_ORACLE = '0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd';
const ORACLE_ADMIN_CAP = '0x33adac6f64ae3ecb1af395de98f9a4f0708d1d97f4848a32dc428a7b9e651b87';
const KEEPER_CAP = '0x3767fad45d82370652ccec28025f83545833ee7f2e1567042b7f5067a3ab1e3a';
const HANDLE_REGISTRY = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const ALLOWLIST = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const MARGIN_POOL = '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d';
const MARGIN_REGISTRY = '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75';
const CLOCK = '0x6';
const SYMBOL = 'SPCX';

// the demo flash-crash path (validated against the Move integer math offline):
// latch expected on tick 4, auto-release expected on tick 10. Written in the
// $185 era — scaled to the LIVE mark at start so the returns (what the EWMA
// sees) are identical at any nominal.
const PATH_BASE = [184.6, 185.3, 184.9, 148.0, 152.5, 147.8, 151.2, 149.6, 150.4, 150.1, 150.6];
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

function createdAll(r: { objectChanges?: unknown[] | null }, frag: string): string[] {
  return (r.objectChanges ?? [])
    .filter((o) => (o as { type?: string }).type === 'created' && ((o as { objectType?: string }).objectType ?? '').includes(frag))
    .map((o) => (o as { objectId: string }).objectId);
}

async function main() {
  console.log('— EWMA vol loop smoke (testnet, real DBUSDC) —\n');

  // 0. fresh stage — TWO scratch desks + a tiny real forward: the IM-only
  // policy is on-chain now, so the $5 deploy needs $5 of LOCKED margin.
  const stamp = Date.now().toString(36);
  const mk = async (handle: string) => {
    const r = await run(`create institution @${handle}`, (tx) => {
      const cap = tx.moveCall({
        target: `${PKG}::institution::create_institution`,
        typeArguments: [DBUSDC],
        arguments: [tx.object(HANDLE_REGISTRY), tx.pure.string(handle)],
      });
      tx.transferObjects([cap], me);
    });
    return { inst: created(r, '::institution::Institution<'), adminCap: created(r, '::institution::AdminCap') };
  };
  const A = await mk(`fmsmoke${stamp}`);
  const B = await mk(`fmsmokeb${stamp}`);
  const inst = A.inst;
  const adminCap = A.adminCap;
  console.log(`✓ desks ${A.inst.slice(0, 10)}… / ${B.inst.slice(0, 10)}…`);

  let s = await status(inst);
  const m0 = s.mark; // live nominal (post-reset: $148)
  const PATH = PATH_BASE.map((p) => (p / PATH_BASE[0]) * m0);
  const EXPIRY_MS = Date.now() + 240_000;

  const rg = await run('fund both + grant traders', (tx) => {
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(A.inst), tx.object(A.adminCap), coinWithBalance({ type: DBUSDC, balance: 10_000_000n })],
    });
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(B.inst), tx.object(B.adminCap), coinWithBalance({ type: DBUSDC, balance: 6_000_000n })],
    });
    const ta = tx.moveCall({
      target: `${PKG}::institution::grant_trader`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(A.inst), tx.object(A.adminCap), tx.pure.address(me), tx.pure.u64(1_000_000_000_000n)],
    });
    const tb = tx.moveCall({
      target: `${PKG}::institution::grant_trader`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(B.inst), tx.object(B.adminCap), tx.pure.address(me), tx.pure.u64(1_000_000_000_000n)],
    });
    tx.transferObjects([ta, tb], me);
  });
  const tcaps = createdAll(rg, '::institution::TraderCap');

  const ro = await run('open 0.01 SPCX forward (locks $5 IM each)', (tx) => {
    tx.moveCall({
      target: `${PKG}::otc_forward::open`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(A.inst), tx.object(tcaps[0]), tx.object(B.inst), tx.object(tcaps[1]), tx.object(ALLOWLIST),
        tx.pure.string(SYMBOL), tx.pure.u64(10_000n), tx.pure.u64(BigInt(Math.round(m0 * 1e6))), tx.pure.u64(5_000_000n),
        tx.pure.u64(0n), tx.pure.bool(false), tx.pure.u64(0n), tx.pure.u64(BigInt(EXPIRY_MS)), tx.object(CLOCK),
      ],
    });
  });
  const fwd = created(ro, '::otc_forward::OtcForward<');

  await run('rehypothecate the locked $5', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(5_000_000n), tx.object(CLOCK)],
    });
  });
  s = await status(inst);
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

  // 3. clean the stage: wait out the contract, close it (frees both fences),
  // recall the smoke funds + withdraw back to ops, reset feed
  const waitMs = EXPIRY_MS - Date.now() + 3_000;
  if (waitMs > 0) {
    console.log(`waiting ${Math.ceil(waitMs / 1000)}s for the smoke contract to expire…`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  await run('close expired smoke contract', (tx) => {
    tx.moveCall({
      target: `${PKG}::otc_forward::close`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(fwd), tx.object(A.inst), tx.object(B.inst), tx.object(RISK_ORACLE), tx.object(ALLOWLIST), tx.object(CLOCK)],
    });
  });
  await run('cleanup: recall + withdraw + reset feed', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::recall`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(5_000_000n), tx.object(CLOCK)],
    });
    const c = tx.moveCall({
      target: `${PKG}::institution::withdraw_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.pure.u64(9_500_000n)],
    });
    const cb = tx.moveCall({
      target: `${PKG}::institution::withdraw_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(B.inst), tx.object(B.adminCap), tx.pure.u64(5_800_000n)],
    });
    tx.transferObjects([c, cb], me);
    tx.moveCall({
      target: `${PKG}::oracle::disable_vol`,
      arguments: [tx.object(RISK_ORACLE), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SYMBOL)],
    });
    tx.moveCall({
      target: `${PKG}::oracle::push_price`,
      arguments: [tx.object(RISK_ORACLE), tx.object(KEEPER_CAP), tx.pure.string(SYMBOL), tx.pure.u64(148_000_000n), tx.object(CLOCK)],
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
