/**
 * Headless rehearsal of the FULL demo drill against the running dev server
 * (localhost:3000) + live testnet — exactly the calls the UI makes, on the
 * CURRENT recipe (SPCX ~$148, IM-only rehypothecation on-chain):
 *
 *   setup   scratch desk: deposit $42, open a 1-SPCX direct forward vs an ops
 *           maker desk (IM $8 each — the modal default), rehypothecate the
 *           WHOLE locked IM ($8) → available $26 (equity − locked IM)
 *   beat 1  PRE-EMPTED CRASH: the gap tick latches; the armed crank PAYS the
 *           ~$29 VM outright (available $34 covers) — NO margin call — and the
 *           armed-but-payable fallback recall brings the $8 IM home
 *   release ticks continue → 3 calm prints → latch auto-releases on-chain;
 *           redeposit (within locked IM) works post-release
 *   beat 2  ⚡ GAP on the now-drained desk: VM ~$22 > available ~$5 → MARGIN
 *           CALL (due process). Cure attempt #1 (recall alone) CANNOT cover —
 *           a desk's own locked IM never pays its own VM — then the DAILY
 *           TREASURY RELOAD (+$20, what the app's auto-cure wires) + re-cure
 *           → PAYS and SURVIVES. Cleanup closes the contract + sweeps.
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
const PKG = '0x141f7de4ea75cde406d424a0669e17e34352ef9fd594bcae6f0139ef6dd74700';
const ORIGINAL_PKG = '0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf';
const HANDLE_REGISTRY = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const ALLOWLIST = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const MARGIN_POOL = '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d';
const MARGIN_REGISTRY = '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75';
const CLOCK = '0x6';
const CUMBERLAND = '0xf6de982cc7cae66c76c230bffc5162b412f35612caff475afe19ccfa208522df';

// $185-era shape — scaled to the live mark at start (returns are what matter)
const PATH_BASE = [184.6, 185.3, 184.9, 148.0, 152.5, 147.8, 151.2, 149.6, 150.4, 150.1, 150.6];

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
  const st0 = await oracle({ action: 'reset' });
  const m0: number = st0.mark; // nominal after reset ($148)
  const PATH = PATH_BASE.map((p) => (p / PATH_BASE[0]) * m0);
  console.log(`✓ stage reset ($${m0}, σ re-seeded)`);

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
  const r2 = await run('grant trader + deposit 42', (tx) => {
    const t = tx.moveCall({
      target: `${PKG}::institution::grant_trader`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.pure.address(me), tx.pure.u64(1_000_000_000_000n)],
    });
    tx.transferObjects([t], me);
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), coinWithBalance({ type: DBUSDC, balance: 42_000_000n })],
    });
  });
  const traderCap = created(r2, '::institution::TraderCap');
  console.log(`✓ desk ${inst.slice(0, 10)}… funded $42`);

  // direct forward vs Cumberland: 1 SPCX @ the live mark, IM $8 (modal
  // default), daily settle, SHORT expiry so the cleanup can close it after
  const EXPIRY_MS = Date.now() + 420_000;
  const r3 = await run('propose direct (long 1 SPCX)', (tx) => {
    tx.moveCall({
      target: `${PKG}::direct::propose_direct`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(inst), tx.object(traderCap), tx.object(ALLOWLIST),
        tx.pure.id(CUMBERLAND), tx.pure.u8(0), tx.pure.string('SPCX'),
        tx.pure.u64(1_000_000n), tx.pure.u64(BigInt(Math.round(m0 * 1e6))), tx.pure.u64(8_000_000n),
        tx.pure.u64(0n), tx.pure.bool(false), tx.pure.u64(86_400_000n),
        tx.pure.u64(BigInt(EXPIRY_MS)), tx.pure.u64(3_600_000n), tx.object(CLOCK),
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
  console.log(`✓ OtcForward ${otc.slice(0, 10)}… open (IM $8 each, MM buffer $2.40)`);

  // deploy the WHOLE locked IM ($8) → available $26 < the ~$29 VM of the crash
  await run('rehypothecate the locked $8', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(8_000_000n), tx.object(CLOCK)],
    });
  });
  let n = await instNums(inst);
  console.log(`✓ deployed: liquid $${n.liquid} · in DeepBook $${n.rehyp}\n`);

  // ---- beat 1: the pre-empted crash, via the app's own API ----
  let paidOutright = false;
  let recalled = false;
  let releaseTick = -1;
  let wasTriggered = false;
  for (let i = 0; i < PATH.length; i++) {
    const tick = i + 1;
    const r = await oracle({ action: 'tick', instId: inst, price: PATH[i], otcIds: [otc] });
    const state = r.triggered ? 'LATCHED' : 'calm   ';
    console.log(`tick ${String(tick).padStart(2)}: $${r.mark.toFixed(2).padStart(7)} | σ ${String(r.sigmaBps).padStart(4)} | ${state} | release ${r.releaseProgress}/3`);
    for (const m of r.marginCalls ?? []) {
      if (m.deadline != null) throw new Error('beat 1 must PAY outright — a margin call fired (desk sizing wrong?)');
      paidOutright = true;
      console.log('        ✓ armed crank PAID the VM outright — no margin call (available covers)');
    }
    if (r.recalled) {
      recalled = true;
      console.log(`        ✓ armed-but-payable fallback recall fired — $${r.recalledAmount} home`);
    }
    if (wasTriggered && !r.triggered) releaseTick = tick;
    wasTriggered = r.triggered;
  }
  n = await instNums(inst);
  console.log(`\npost-crash: liquid $${n.liquid} · DeepBook $${n.rehyp} (VM paid step-by-step, collateral home)`);
  if (!paidOutright) throw new Error('no armed crank paid during the crash');
  if (!recalled) throw new Error('fallback recall never fired');
  if (releaseTick < 0) throw new Error('latch never auto-released');
  console.log(`✓ latch auto-released on-chain at tick ${releaseTick}`);

  // post-release redeposit (the UI does this as the desk's sponsored tx) —
  // within BOTH caps: the locked IM ($8) and what the floor leaves deployable
  // of the VM-drained liquid (~$4.7 left − $2 floor)
  await run('redeposit after release (within locked IM + floor)', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(2_500_000n), tx.object(CLOCK)],
    });
  });
  n = await instNums(inst);
  console.log(`✓ redeposited: liquid $${n.liquid} · DeepBook $${n.rehyp}`);

  /* ---- beat 2: ⚡ GAP on the drained desk → MARGIN CALL → reload cures ----
     VM ~$22 vs available ~$5: the call fires (due process). Cure attempt #1
     (recall alone) CANNOT cover — the recall moves funds home, it adds
     nothing, and a desk's own locked IM never pays its own VM. The DAILY
     TREASURY RELOAD (+$20 — exactly what the app's auto-cure wires via the
     mock on-ramp) then covers it, and the re-cure pays & survives. */
  const p2 = PATH[PATH.length - 1] * 0.8;
  const crash2 = await oracle({ action: 'tick', instId: inst, price: Number(p2.toFixed(2)), otcIds: [otc] });
  const call2 = (crash2.marginCalls ?? []).find((m: { deadline: number | null }) => m.deadline != null);
  console.log(`\n⚡ gap: $${crash2.mark} | latched ${crash2.triggered} | margin call ${call2 ? 'RECORDED (deadline ' + new Date(call2.deadline).toISOString().slice(11, 19) + ')' : 'missing'}`);
  if (!crash2.triggered) throw new Error('the gap did not latch');
  if (!call2) throw new Error('expected a margin call on the drained desk');

  const cure1 = await oracle({ action: 'cure', instId: inst, otcIds: [otc] });
  const c1 = (cure1.cured ?? [])[0];
  const stillCalled = !c1 || (c1.deadline != null && c1.status === 0);
  console.log(`cure #1 (recall alone): recalled $${cure1.recalledAmount ?? 0} · ${stillCalled ? 'STILL CALLED — recall cannot ADD capital ✓ (expected)' : 'unexpectedly cleared'}`);
  if (!stillCalled) throw new Error('recall alone should NOT have covered the VM');

  await run('daily treasury reload (+$20, the capital-call cure)', (tx) => {
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), coinWithBalance({ type: DBUSDC, balance: 20_000_000n })],
    });
  });
  const cure2 = await oracle({ action: 'cure', instId: inst, otcIds: [otc] });
  const c2 = (cure2.cured ?? [])[0];
  console.log(`cure #2 (post-reload): deadline=${c2?.deadline ?? 'CLEARED'} status=${c2?.status === 0 ? 'ACTIVE (survived)' : c2?.status}`);
  if (c2?.deadline != null || c2?.status !== 0) throw new Error('reload cure did not clear the call');

  // cleanup: wait out the contract, close it (frees both $8 fences), recall
  // what is deployed, sweep the scratch desk back to ops, reset the stage
  const waitMs = EXPIRY_MS - Date.now() + 3_000;
  if (waitMs > 0) {
    console.log(`\nwaiting ${Math.ceil(waitMs / 1000)}s for the drill contract to expire…`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
  await run('close expired drill contract', (tx) => {
    tx.moveCall({
      target: `${PKG}::otc_forward::close`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(otc), tx.object(inst), tx.object(CUMBERLAND), tx.object('0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd'), tx.object(ALLOWLIST), tx.object(CLOCK)],
    });
  });
  n = await instNums(inst);
  if (n.rehyp > 0) {
    await run('recall remaining deploy', (tx) => {
      tx.moveCall({
        target: `${PKG}::rehypo::recall`,
        typeArguments: [DBUSDC],
        arguments: [tx.object(inst), tx.object(adminCap), tx.object(MARGIN_POOL), tx.object(MARGIN_REGISTRY), tx.pure.u64(BigInt(Math.floor(n.rehyp * 1e6))), tx.object(CLOCK)],
      });
    });
  }
  n = await instNums(inst);
  const sweep = Math.max(0, Math.floor((n.liquid - 0.05) * 1e6));
  if (sweep > 0) {
    await run('sweep scratch desk back to ops', (tx) => {
      const c = tx.moveCall({
        target: `${PKG}::institution::withdraw_treasury`,
        typeArguments: [DBUSDC],
        arguments: [tx.object(inst), tx.object(adminCap), tx.pure.u64(BigInt(sweep))],
      });
      tx.transferObjects([c], me);
    });
  }
  await oracle({ action: 'reset' });
  console.log('\nPASS — beat 1: pre-empted crash pays outright + fallback recall + release + redeposit; beat 2: gap → MARGIN CALL → recall-alone insufficient (correct) → daily reload cures → survives. Stage clean.');
}

main().catch((e) => {
  console.error('FAIL:', e.message ?? e);
  process.exit(1);
});
