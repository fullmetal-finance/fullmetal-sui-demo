/**
 * READ-ONLY fund reconciliation for demo planning. Reports:
 *   - DBUSDC + SUI in the faucet and ops wallets
 *   - every ops-controlled desk (treasury / reserved / rehypothecated)
 *   - how much is recoverable to ops (recall + withdraw, keep $20/maker)
 *   - a grand total of all DBUSDC we control
 * Signs nothing. Usage: npx tsx recon-funds.ts
 */
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { TESTNET_JSONRPC_URL } from './rpc';

const ORIGINAL_PKG = '0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const OPS = '0x6849af55b4f2f429cb2665ec9f4d42c17eecc76211f14caf959903ad786d5576';
const FAUCET = '0x0d879d8906caba0f84f03c285bd52ee6c317b726a89962adcf96719963167178';
const MAKER_INSTS = ['0xf6de982c', '0x31089de7', '0xfb4db2ec'];
const SCRATCH = /^fm(smoke|drill|demo|dust)/;
const MAKER_FLOAT = 20; // keep $20 in each maker desk to quote

const client = new SuiJsonRpcClient({ url: TESTNET_JSONRPC_URL });
const usd = (u: bigint | string | number) => Number(u) / 1e6;
const sui = (u: bigint | string | number) => Number(u) / 1e9;

async function main() {
  const [fBal, oBal, fSui, oSui] = await Promise.all([
    client.getBalance({ owner: FAUCET, coinType: DBUSDC }),
    client.getBalance({ owner: OPS, coinType: DBUSDC }),
    client.getBalance({ owner: FAUCET }),
    client.getBalance({ owner: OPS }),
  ]);

  // every (institution, adminCap) the ops key controls
  const caps: { inst: string }[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await client.getOwnedObjects({
      owner: OPS,
      filter: { StructType: `${ORIGINAL_PKG}::institution::AdminCap` },
      options: { showContent: true },
      cursor: cursor ?? undefined,
    });
    for (const o of page.data) {
      const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
      if (iid) caps.push({ inst: iid });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  let sumTreasury = 0, sumReserved = 0, sumRehyp = 0, recoverable = 0;
  const rows: string[] = [];
  for (const { inst } of caps) {
    const o = await client.getObject({ id: inst, options: { showContent: true } });
    const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f) continue;
    const handle = String(f.handle ?? '');
    const treasury = usd(f.treasury ?? '0');
    const reserved = usd(f.reserved ?? '0');
    const rehyp = usd(f.rehypothecated ?? '0');
    const equity = treasury + rehyp;
    const available = Math.max(0, equity - reserved);
    const isScratch = SCRATCH.test(handle);
    const isMaker = MAKER_INSTS.some((p) => inst.startsWith(p)) || ['cumberland', 'galaxy', 'wintermute'].some((m) => handle.includes(m));
    const kind = isScratch ? 'scratch' : isMaker ? 'maker' : 'other';
    // recoverable to ops: scratch → full available (recall rehyp + withdraw);
    // maker → available above the $20 float; other → available
    const rec = isMaker ? Math.max(0, available - MAKER_FLOAT) : available;
    sumTreasury += treasury; sumReserved += reserved; sumRehyp += rehyp; recoverable += rec;
    rows.push(
      `  ${kind.padEnd(7)} @${handle.slice(0, 20).padEnd(20)} ${inst.slice(0, 10)}…  treasury $${treasury.toFixed(2).padStart(8)} · reserved $${reserved.toFixed(2).padStart(7)} · DeepBook $${rehyp.toFixed(2).padStart(7)} · avail $${available.toFixed(2).padStart(7)} · →ops $${rec.toFixed(2)}`,
    );
  }

  const p = (n: number) => `$${n.toFixed(2)}`;
  console.log('=== WALLETS ===');
  console.log(`  FAUCET  ${FAUCET.slice(0, 12)}…  DBUSDC ${p(usd(fBal.totalBalance))}  ·  SUI ${sui(fSui.totalBalance).toFixed(3)}`);
  console.log(`  OPS     ${OPS.slice(0, 12)}…  DBUSDC ${p(usd(oBal.totalBalance))}  ·  SUI ${sui(oSui.totalBalance).toFixed(3)}`);
  console.log(`\n=== OPS-CONTROLLED DESKS (${caps.length}) ===`);
  rows.sort().forEach((r) => console.log(r));
  console.log(`\n  desk totals: treasury(liquid) ${p(sumTreasury)} · reserved(locked IM) ${p(sumReserved)} · DeepBook(rehyp) ${p(sumRehyp)}`);
  console.log(`  recoverable to ops (recall + withdraw, keep $20/maker): ${p(recoverable)}`);

  const walletsNow = usd(fBal.totalBalance) + usd(oBal.totalBalance);
  const grand = walletsNow + sumTreasury + sumRehyp;
  console.log(`\n=== TOTALS ===`);
  console.log(`  in wallets now (faucet + ops):        ${p(walletsNow)}`);
  console.log(`  mobilizable = wallets + recoverable:  ${p(walletsNow + recoverable)}`);
  console.log(`  GRAND TOTAL DBUSDC (wallets + all desk equity incl. DeepBook): ${p(grand)}`);
  console.log(`  (note: your live signed-in desk is owned by your zkLogin wallet, not ops — its balance is separate/in-flight.)`);
}

main().catch((e) => { console.error(e.message ?? e); process.exit(1); });
