/**
 * Headless rehearsal of the FULL demo drill against the running dev server
 * (localhost:3000) + live testnet — exactly the calls the UI makes:
 *
 *   setup   scratch desk: deposit 100 DBUSDC, open a 1-SPCX direct forward vs
 *           an ops maker desk (IM 9.25 each), rehypothecate 70 → liquid 30
 *   crash   drive the flash-crash path through POST /api/oracle {action:tick}
 *           with the contract armed → the latch tick must return MARGIN CALLS
 *           (VM owed 37 > liquid 30 — funds are out earning)
 *   cure    POST {action:cure} → permissionless recall + re-crank → position
 *           PAYS and SURVIVES (deadline cleared, status still ACTIVE)
 *   release ticks continue → 3 calm prints → latch auto-releases on-chain
 *   verify  redeposit works again post-release; stage reset at the end
 *
 * Usage: npx tsx drill-smoke.ts   (dev server must be running)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

const API = process.env.API ?? 'http://localhost:3000';
const PKG = '0xf8b57f09dfe5e59fcc176110c8f15cf96b27f6f23be8a4db959529d896635a4a';
const ORIGINAL_PKG = '0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf';
const HANDLE_REGISTRY = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const ALLOWLIST = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const MARGIN_POOL = '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d';
const MARGIN_REGISTRY = '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75';
const CLOCK = '0x6';
const CUMBERLAND = '0xf6de982cc7cae66c76c230bffc5162b412f35612caff475afe19ccfa208522df';

const PATH = [184.6, 185.3, 184.9, 148.0, 152.5, 147.8, 151.2, 149.6, 150.4, 150.1, 150.6];

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

async function run(label: string, build: (tx: Transaction) => void) {
  const tx = new Transaction();
  build(tx);
  const res = await client.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true, showObjectChanges: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') throw new Error(`${label} FAILED: ${JSON.stringify(res.effects?.status)}`);
  return res;
}

function created(res: { objectChanges?: unknown[] | null }, frag: string): string {
  const c = (res.objectChanges ?? []).find(
    (o) => (o as { type?: string }).type === 'created' && ((o as { objectType?: string }).objectType ?? '').includes(frag),
  );
  if (!c) throw new Error('no created ' + frag);
  return (c as { objectId: string }).objectId;
}

async function oracle(body: Record<string, unknown>) {
  const r = await fetch(`${API}/api/oracle`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const d = await r.json();
  if (!r.ok) throw new Error(`oracle ${r.status}: ${d.error}`);
  return d;
}

async function instNums(inst: string): Promise<{ liquid: number; rehyp: number }> {
  const o = await client.getObject({ id: inst, options: { showContent: true } });
  const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields ?? {};
  return { liquid: Number(f.treasury ?? 0) / 1e6, rehyp: Number(f.rehypothecated ?? 0) / 1e6 };
}

async function capsFor(instId: string) {
  const out = { admin: '', trader: '' };
  for (const type of ['AdminCap', 'TraderCap']) {
    let cursor: string | null | undefined = null;
    do {
      const page = await client.getOwnedObjects({
        owner: me,
        filter: { StructType: `${ORIGINAL_PKG}::institution::${type}` },
        options: { showContent: true },
        cursor: cursor ?? undefined,
      });
      for (const o of page.data) {
        const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
        if (iid === instId) {
          if (type === 'AdminCap') out.admin = o.data!.objectId;
          else out.trader = o.data!.objectId;
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
  }
  if (!out.admin || !out.trader) throw new Error(`no caps for ${instId}`);
  return out;
}

async function main() {
  console.log('— drill smoke: margin call → cure → survive → release —\n');
  await oracle({ action: 'reset' });
  console.log('✓ stage reset ($185, σ re-seeded)');

  // scratch desk with a trader seat
  const handle = `fmdrill${Date.now().toString(36)}`;
  const r1 = await run('create desk', (tx) => {
    const cap = tx.moveCall({
      target: `${PKG}::institution::create_institution`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(HANDLE_REGISTRY), tx.pure.string(handle)],
    });
    tx.transferObjects([cap], me);
  });
  const inst = created(r1, '::institution::Institution<');
  const adminCap = created(r1, '::institution::AdminCap');
  const r2 = await run('grant trader + deposit 100', (tx) => {
    const t = tx.moveCall({
      target: `${PKG}::institution::grant_trader`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.pure.address(me), tx.pure.u64(1_000_000_000_000n)],
    });
    tx.transferObjects([t], me);
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), coinWithBalance({ type: DBUSDC, balance: 100_000_000n })],
    });
  });
  const traderCap = created(r2, '::institution::TraderCap');
  console.log(`✓ desk ${inst.slice(0, 10)}… funded $100`);

  // direct forward vs Cumberland: 1 SPCX @ 185, IM 9.25 (5%), daily settle, 7d
  const r3 = await run('propose direct (long 1 SPCX)', (tx) => {
    tx.moveCall({
      target: `${PKG}::direct::propose_direct`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(inst), tx.object(traderCap), tx.object(ALLOWLIST),
        tx.pure.id(CUMBERLAND), tx.pure.u8(0), tx.pure.string('SPCX'),
        tx.pure.u64(1_000_000n), tx.pure.u64(185_000_000n), tx.pure.u64(9_250_000n),
        tx.pure.u64(0n), tx.pure.bool(false), tx.pure.u64(86_400_000n),
        tx.pure.u64(BigInt(Date.now() + 7 * 86_400_000)), tx.pure.u64(3_600_000n), tx.object(CLOCK),
      ],
    });
  });
  const offer = created(r3, '::direct::DirectOffer<');
  const cCaps = await capsFor(CUMBERLAND);
  const r4 = await run('cumberland accepts', (tx) => {
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(CUMBERLAND), tx.object(cCaps.admin), coinWithBalance({ type: DBUSDC, balance: 15_000_000n })],
    });
    tx.moveCall({
      target: `${PKG}::direct::accept_direct`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(offer), tx.object(CUMBERLAND), tx.object(cCaps.trader), tx.object(inst), tx.object(ALLOWLIST), tx.object(CLOCK)],
    });
  });
  const otc = created(r4, '::otc_forward::OtcForward<');
  console.log(`✓ OtcForward ${otc.slice(0, 10)}… open (IM $9.25 each, MM buffer $2.78)`);

  // deploy 70 → liquid 30 < the $37 VM a −20% crash owes
  await run('rehypothecate 70', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(70_000_000n), tx.object(CLOCK)],
    });
  });
  let n = await instNums(inst);
  console.log(`✓ deployed: liquid $${n.liquid} · in DeepBook $${n.rehyp}\n`);

  // ---- the crash, via the app's own API ----
  let calls: { otcId: string; deadline: number | null; status: number }[] = [];
  let cured = false;
  let releaseTick = -1;
  let wasTriggered = false;
  for (let i = 0; i < PATH.length; i++) {
    const tick = i + 1;
    const r = await oracle({ action: 'tick', instId: inst, price: PATH[i], otcIds: cured ? undefined : [otc] });
    const state = r.triggered ? 'LATCHED' : 'calm   ';
    console.log(`tick ${String(tick).padStart(2)}: $${r.mark.toFixed(2).padStart(7)} | σ ${String(r.sigmaBps).padStart(4)} | ${state} | release ${r.releaseProgress}/3`);
    if (r.marginCalls?.length && !cured) {
      calls = r.marginCalls;
      const d = calls[0].deadline;
      console.log(`        ⚠ MARGIN CALL recorded — cure deadline ${d ? new Date(d).toISOString().slice(11, 19) : '—'} (90s window)`);
      if (calls[0].deadline == null) throw new Error('expected a margin-call deadline');
      const cu = await oracle({ action: 'cure', instId: inst, otcIds: [otc] });
      const c = (cu.cured ?? [])[0];
      console.log(`        ✓ cure: recalled $${cu.recalledAmount} · post-crank deadline=${c?.deadline ?? 'CLEARED'} status=${c?.status === 0 ? 'ACTIVE (survived)' : c?.status}`);
      if (!cu.recalled || c?.deadline != null || c?.status !== 0) throw new Error('cure did not clear the call');
      cured = true;
    }
    if (wasTriggered && !r.triggered) releaseTick = tick;
    wasTriggered = r.triggered;
  }
  n = await instNums(inst);
  console.log(`\npost-crash: liquid $${n.liquid} · DeepBook $${n.rehyp} (VM paid from recalled liquidity)`);
  if (releaseTick < 0) throw new Error('latch never auto-released');
  console.log(`✓ latch auto-released on-chain at tick ${releaseTick}`);

  // post-release redeposit (the UI does this as the desk's sponsored tx)
  await run('redeposit after release', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(30_000_000n), tx.object(CLOCK)],
    });
  });
  n = await instNums(inst);
  console.log(`✓ redeposited: liquid $${n.liquid} · DeepBook $${n.rehyp}`);

  // stage reset for the real demo
  await oracle({ action: 'reset' });
  console.log('\nPASS — margin call → cure(recall+pay) → survive → on-chain release → redeposit, all live.');
}

main().catch((e) => {
  console.error('FAIL:', e.message ?? e);
  process.exit(1);
});
