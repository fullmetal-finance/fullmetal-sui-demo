/**
 * Maker quote service (demo). Given an RFQ id, three desks I control each post a
 * FIRM, collateral-backed quote at a staggered price, then write the quotes to
 * frontend/public/quotes-<rfqId>.json — the off-chain channel the dashboard's RFQ
 * inbox polls. The requester then accepts the best one on-chain. Real quotes:
 * each reserves real IM in its institution.
 *
 * Usage: npx tsx makers-quote.ts <rfqId>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { TESTNET_JSONRPC_URL } from './rpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

const PKG = '0x53ed96a991241db1e20c964930f1e9981c2db438f74dc17867f9705bd8b392b0';
const ALLOW = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const CLOCK = '0x6';
const ACTIVE = '0x6849af55b4f2f429cb2665ec9f4d42c17eecc76211f14caf959903ad786d5576';

// three desks I control, mapped to demo display names + staggered prices ($)
const MAKERS = [
  { instPrefix: '0xf6de982c', org: 'Cumberland', price: 184.1 },
  { instPrefix: '0x31089de7', org: 'Galaxy Digital', price: 185.0 },
  { instPrefix: '0xfb4db2ec', org: 'Wintermute', price: 185.4 },
];

function keypair(): Ed25519Keypair {
  const cfg = join(homedir(), '.sui', 'sui_config');
  for (const b64 of JSON.parse(readFileSync(join(cfg, 'sui.keystore'), 'utf8')) as string[]) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.toSuiAddress() === ACTIVE) return kp;
  }
  throw new Error('active key not found');
}

async function caps(c: SuiJsonRpcClient) {
  let cursor: string | null | undefined = null;
  const out: Record<string, { inst: string; admin: string; trader: string }> = {};
  do {
    const res = await c.getOwnedObjects({ owner: ACTIVE, cursor: cursor ?? undefined, options: { showType: true, showContent: true } });
    for (const o of res.data) {
      const t = o.data?.type ?? '';
      const iid = (o.data?.content as any)?.fields?.institution_id as string | undefined;
      if (!iid) continue;
      const key = iid.slice(0, 10);
      out[key] ??= { inst: iid, admin: '', trader: '' };
      if (t.includes('::AdminCap')) out[key].admin = o.data!.objectId;
      if (t.includes('::TraderCap')) out[key].trader = o.data!.objectId;
    }
    cursor = res.hasNextPage ? res.nextCursor : null;
  } while (cursor);
  return out;
}

async function main() {
  const rfqId = process.argv[2];
  if (!rfqId) throw new Error('usage: makers-quote.ts <rfqId>');
  const kp = keypair();
  const c = new SuiJsonRpcClient({ network: 'testnet', url: TESTNET_JSONRPC_URL });

  // read RFQ im_each + expiry
  const rfq = await c.getObject({ id: rfqId, options: { showContent: true } });
  const rf = (rfq.data?.content as any)?.fields ?? {};
  const imUnits = BigInt(rf.im_each ?? '5000000');
  const im = Number(imUnits) / 1e6;
  const rfqExpiry = Number(rf.rfq_expiry_ms ?? '0');
  const clk = await c.getObject({ id: CLOCK, options: { showContent: true } });
  const now = Number((clk.data?.content as any)?.fields?.timestamp_ms ?? Date.now());
  const ttl = BigInt(Math.max(60_000, Math.min(rfqExpiry - now - 30_000, 1_800_000)));
  const expiresMin = Math.floor(Number(ttl) / 60000);

  const capMap = await caps(c);
  const out: { org: string; quoteId: string; price: number; im: number; ttl: string }[] = [];

  for (const m of MAKERS) {
    const entry = Object.values(capMap).find((v) => v.inst.startsWith(m.instPrefix));
    if (!entry || !entry.admin || !entry.trader) { console.log(`skip ${m.org}: no caps`); continue; }
    // fund a little so it can firm-reserve the IM
    const fund = new Transaction();
    fund.moveCall({ target: `${PKG}::institution::deposit_treasury`, typeArguments: [DBUSDC], arguments: [fund.object(entry.inst), fund.object(entry.admin), coinWithBalance({ type: DBUSDC, balance: imUnits + 2_000_000n })] });
    let r = await c.signAndExecuteTransaction({ signer: kp, transaction: fund, options: { showEffects: true } });
    await c.waitForTransaction({ digest: r.digest });

    const q = new Transaction();
    q.moveCall({
      target: `${PKG}::rfq::submit_quote`,
      typeArguments: [DBUSDC],
      arguments: [q.object(rfqId), q.object(entry.inst), q.object(entry.trader), q.object(ALLOW), q.pure.u64(BigInt(Math.round(m.price * 1e6))), q.pure.u64(ttl), q.object(CLOCK)],
    });
    r = await c.signAndExecuteTransaction({ signer: kp, transaction: q, options: { showEffects: true, showObjectChanges: true } });
    await c.waitForTransaction({ digest: r.digest });
    if (r.effects?.status.status !== 'success') { console.log(`${m.org} quote FAILED: ${JSON.stringify(r.effects?.status)}`); continue; }
    const quoteId = (r.objectChanges ?? []).find((o: any) => o.type === 'created' && (o.objectType ?? '').includes('::rfq::Quote<'))?.objectId as string;
    out.push({ org: m.org, quoteId, price: m.price, im, ttl: `${expiresMin}:00` });
    console.log(`✓ ${m.org} quoted $${m.price.toFixed(2)} → ${quoteId.slice(0, 10)}…`);
  }

  const path = join(import.meta.dirname ?? '.', '..', 'frontend', 'public', `quotes-${rfqId}.json`);
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${out.length} quotes → ${path}`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
