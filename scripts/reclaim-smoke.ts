/**
 * Live regression for "Reset desk" discovery + reclamation, replicating the
 * stuck-funds case: an institution with NO local records whose IM is fenced by
 *   (a) an EXPIRED OtcForward   → freed via permissionless `close`
 *   (b) an EXPIRED DirectOffer  → freed via permissionless `reclaim_expired_direct`
 *
 * Discovery mirrors frontend/lib/reset-desk.ts: enumerate the institution's
 * on-chain `contracts` table (open rows), classify each row's target object,
 * free, then withdraw the EXACT re-read balance. Ops-signed (mechanics test —
 * the browser flow signs the same PTBs via Enoki).
 *
 * Usage: npx tsx reclaim-smoke.ts     (~90s: one wait for offer-TTL skew)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

const PKG = '0x141f7de4ea75cde406d424a0669e17e34352ef9fd594bcae6f0139ef6dd74700';
const REG = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const ALLOW = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const ORACLE = '0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const CLOCK = '0x6';

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
const kp = keypair();
const me = kp.toSuiAddress();
const c = new SuiJsonRpcClient({ url: TESTNET_JSONRPC_URL });

async function run(label: string, build: (tx: Transaction) => void) {
  const tx = new Transaction();
  build(tx);
  const res = await c.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true, showObjectChanges: true } });
  await c.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') throw new Error(`${label}: ${JSON.stringify(res.effects?.status)}`);
  console.log('✓', label);
  return res;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
const created = (res: any, frag: string) =>
  (res.objectChanges ?? []).find((o: any) => o.type === 'created' && (o.objectType ?? '').includes(frag))?.objectId as string;

async function inst(id: string) {
  const o: any = await c.getObject({ id, options: { showContent: true } });
  const f = o.data.content.fields;
  return {
    treasury: BigInt(f.treasury),
    reserved: BigInt(f.reserved),
    table: f.contracts.fields.id.id as string,
  };
}

async function mkDesk(handle: string, fund: bigint) {
  const r = await run(`create @${handle}`, (tx) => {
    const cap = tx.moveCall({ target: `${PKG}::institution::create_institution`, typeArguments: [DBUSDC], arguments: [tx.object(REG), tx.pure.string(handle)] });
    tx.transferObjects([cap], me);
  });
  const i = created(r, '::institution::Institution<');
  const a = created(r, '::institution::AdminCap');
  const r2 = await run(`fund @${handle}`, (tx) => {
    const t = tx.moveCall({ target: `${PKG}::institution::grant_trader`, typeArguments: [DBUSDC], arguments: [tx.object(i), tx.object(a), tx.pure.address(me), tx.pure.u64(1_000_000_000_000n)] });
    tx.transferObjects([t], me);
    tx.moveCall({ target: `${PKG}::institution::deposit_treasury`, typeArguments: [DBUSDC], arguments: [tx.object(i), tx.object(a), coinWithBalance({ type: DBUSDC, balance: fund })] });
  });
  return { inst: i, admin: a, trader: created(r2, '::institution::TraderCap') };
}

async function main() {
  const stamp = Date.now().toString(36);
  const A = await mkDesk(`fmdusta${stamp}`, 30_000_000n); // the "stuck" desk
  const B = await mkDesk(`fmdustb${stamp}`, 15_000_000n); // counterparty

  // (a) contract born EXPIRED (expiry 10 min in the past — open() doesn't
  //     gate on it): A long 1 SPCX vs B, IM $9.25 each
  const rOff = await run('A proposes (contract expiry in the past)', (tx) => {
    tx.moveCall({
      target: `${PKG}::direct::propose_direct`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(A.inst), tx.object(A.trader), tx.object(ALLOW), tx.pure.id(B.inst), tx.pure.u8(0),
        tx.pure.string('SPCX'), tx.pure.u64(1_000_000n), tx.pure.u64(185_000_000n), tx.pure.u64(9_250_000n),
        tx.pure.u64(0n), tx.pure.bool(false), tx.pure.u64(86_400_000n),
        tx.pure.u64(BigInt(Date.now() - 600_000)), tx.pure.u64(3_600_000n), tx.object(CLOCK),
      ],
    });
  });
  const offer1 = created(rOff, '::direct::DirectOffer<');
  const rAcc = await run('B accepts → expired OtcForward exists', (tx) => {
    tx.moveCall({
      target: `${PKG}::direct::accept_direct`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(offer1), tx.object(B.inst), tx.object(B.trader), tx.object(A.inst), tx.object(ALLOW), tx.object(CLOCK)],
    });
  });
  const otc = created(rAcc, '::otc_forward::OtcForward<');

  // (b) second offer with a 1ms TTL → expires immediately (reclaim after skew)
  await run('A proposes offer with 1ms TTL', (tx) => {
    tx.moveCall({
      target: `${PKG}::direct::propose_direct`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(A.inst), tx.object(A.trader), tx.object(ALLOW), tx.pure.id(B.inst), tx.pure.u8(0),
        tx.pure.string('SPCX'), tx.pure.u64(1_000_000n), tx.pure.u64(185_000_000n), tx.pure.u64(9_250_000n),
        tx.pure.u64(0n), tx.pure.bool(false), tx.pure.u64(86_400_000n),
        tx.pure.u64(BigInt(Date.now() + 7 * 86_400_000)), tx.pure.u64(1n), tx.object(CLOCK),
      ],
    });
  });

  let a = await inst(A.inst);
  console.log(`\nstuck state: liquid $${Number(a.treasury) / 1e6} · FENCED $${Number(a.reserved) / 1e6} (contract IM + offer IM)`);
  if (a.reserved !== 18_500_000n) throw new Error('expected $18.50 fenced');

  console.log('waiting 65s for the offer-TTL clock-skew margin…');
  await new Promise((r) => setTimeout(r, 65_000));

  // ---- DISCOVERY, exactly as reset-desk does it: table rows → classify ----
  const fieldIds: string[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await c.getDynamicFields({ parentId: a.table, cursor: cursor ?? undefined });
    for (const f of page.data) fieldIds.push(f.objectId);
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  const rows = new Map<string, bigint>();
  for (const o of (await c.multiGetObjects({ ids: fieldIds, options: { showContent: true } })) as any[]) {
    const f = o.data?.content?.fields;
    if (f?.value?.fields?.open === true) rows.set(String(f.name), BigInt(f.value.fields.im_reserved));
  }
  console.log(`discovery: ${rows.size} OPEN reservation rows found on-chain (no localStorage)`);
  if (rows.size !== 2) throw new Error('expected 2 open rows');

  const targets = (await c.multiGetObjects({ ids: [...rows.keys()], options: { showContent: true, showType: true } })) as any[];
  const now = Date.now();
  const actions: { kind: string; id: string; long?: string; short?: string; proposer?: string }[] = [];
  for (const o of targets) {
    const type = o.data?.type ?? '';
    const t = o.data?.content?.fields;
    if (type.includes('::otc_forward::OtcForward<') && Number(t.status) === 0 && Number(t.expiry_ms) > 0 && now >= Number(t.expiry_ms) + 60_000) {
      actions.push({ kind: 'close', id: o.data.objectId, long: t.inst_long, short: t.inst_short });
    } else if (type.includes('::direct::DirectOffer<') && Number(t.status) === 0 && now >= Number(t.offer_expiry_ms) + 60_000) {
      actions.push({ kind: 'reclaimDirect', id: o.data.objectId, proposer: t.proposer_inst });
    }
  }
  console.log('classified:', actions.map((x) => x.kind).join(' + '));
  if (actions.length !== 2) throw new Error('expected close + reclaimDirect');

  // ---- FREE + WITHDRAW EXACT, as reset-desk executes it ----
  await run('step 1: close expired contract + reclaim expired offer', (tx) => {
    for (const x of actions) {
      if (x.kind === 'close') {
        tx.moveCall({
          target: `${PKG}::otc_forward::close`,
          typeArguments: [DBUSDC],
          arguments: [tx.object(x.id), tx.object(x.long!), tx.object(x.short!), tx.object(ORACLE), tx.object(ALLOW), tx.object(CLOCK)],
        });
      } else {
        tx.moveCall({
          target: `${PKG}::direct::reclaim_expired_direct`,
          typeArguments: [DBUSDC],
          arguments: [tx.object(x.id), tx.object(x.proposer!), tx.object(ALLOW), tx.object(CLOCK)],
        });
      }
    }
  });

  a = await inst(A.inst);
  console.log(`after freeing: liquid $${Number(a.treasury) / 1e6} · fenced $${Number(a.reserved) / 1e6}`);
  if (a.reserved !== 0n) throw new Error('IM still fenced after close+reclaim');
  const amount = a.treasury > a.reserved ? a.treasury - a.reserved : 0n;
  await run(`step 2: withdraw exact $${Number(amount) / 1e6} → faucet`, (tx) => {
    const coin = tx.moveCall({ target: `${PKG}::institution::withdraw_treasury`, typeArguments: [DBUSDC], arguments: [tx.object(A.inst), tx.object(A.admin), tx.pure.u64(amount)] });
    tx.transferObjects([coin], me);
  });

  // sweep counterparty desk B too
  const b = await inst(B.inst);
  const bAmt = b.treasury > b.reserved ? b.treasury - b.reserved : 0n;
  if (bAmt > 0n) {
    await run(`sweep @B $${Number(bAmt) / 1e6}`, (tx) => {
      const coin = tx.moveCall({ target: `${PKG}::institution::withdraw_treasury`, typeArguments: [DBUSDC], arguments: [tx.object(B.inst), tx.object(B.admin), tx.pure.u64(bAmt)] });
      tx.transferObjects([coin], me);
    });
  }
  console.log(`\nvestigial ${otc.slice(0, 10)}… closed · offer reclaimed · $0 fenced\nPASS — expired-IM reclamation works with zero localStorage.`);
}
main().catch((e) => { console.error('FAIL:', e.message ?? e); process.exit(1); });
