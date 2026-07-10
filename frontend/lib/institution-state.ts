import { Transaction } from "@mysten/sui/transactions";

import {
  CLOCK,
  DBUSDC_TYPE,
  DEEPBOOK,
  SHARED,
  SPCX,
  TARGET,
  fromUnits,
} from "./fullmetal";
import { suiRead } from "./sui";

// any 32-byte address works as a devInspect sender for read-only calls
const READER = SHARED.riskOracle;

function decodeU64(bytes?: number[]): bigint {
  let v = 0n;
  const b = bytes ?? [];
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) + BigInt(b[i]);
  return v;
}

/** Render an absolute expiry timestamp (ms) as a tenor — days to maturity.
 *  0 = perpetual (no expiry). */
function tenorLabel(expiryMs: number): string {
  if (!expiryMs) return "Perp";
  const days = Math.ceil((expiryMs - Date.now()) / 86_400_000);
  return days <= 0 ? "<1d" : `${days}d`;
}

export type InstState = {
  liquid: number; // treasury balance physically present
  reserved: number; // IM reserved across open contracts
  rehypothecated: number; // supplied to DeepBook
  totalRequired: number; // maintenance required
  equity: number; // liquid + rehypothecated
  available: number; // equity − reserved
};

/** Read an Institution's live accounting straight off the object fields
 *  (treasury/reserved/rehypothecated render as plain 6dp integer strings). */
export async function readInstitution(id: string): Promise<InstState> {
  const o = await suiRead.getObject({ id, options: { showContent: true } });
  const f = ((o.data?.content as { fields?: Record<string, string> } | undefined)?.fields ?? {});
  const liquid = fromUnits(f.treasury ?? "0");
  const reserved = fromUnits(f.reserved ?? "0");
  const rehypothecated = fromUnits(f.rehypothecated ?? "0");
  const totalRequired = fromUnits(f.total_required ?? "0");
  const equity = liquid + rehypothecated;
  return {
    liquid,
    reserved,
    rehypothecated,
    totalRequired,
    equity,
    available: Math.max(0, equity - reserved),
  };
}

/** Live value of supplied collateral in the DeepBook pool (principal + interest). */
export async function readSuppliedValue(instId: string): Promise<number> {
  const tx = new Transaction();
  tx.moveCall({
    target: TARGET.rehypo.suppliedValue,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(instId), tx.object(DEEPBOOK.dbusdcMarginPool), tx.object(CLOCK)],
  });
  const r = await suiRead.devInspectTransactionBlock({ sender: READER, transactionBlock: tx });
  return Number(decodeU64(r.results?.[0]?.returnValues?.[0]?.[0] as number[] | undefined)) / 1e6;
}

/** The signed-in desk's real on-chain OtcForwards, shaped for the blotter. */
export async function readUserContracts(
  otcIds: string[],
  myInstId: string,
  myTraderName?: string,
): Promise<import("./mock").MockPosition[]> {
  if (!otcIds.length) return [];
  const objs = await suiRead.multiGetObjects({ ids: otcIds, options: { showContent: true } });
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const name = myTraderName?.trim();
  const rows: import("./mock").MockPosition[] = [];
  for (const o of objs) {
    const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f) continue;
    const isLong = f.inst_long === myInstId;
    rows.push({
      asset: f.underlying ?? "—",
      side: isLong ? "long" : "short",
      // the contract is ours, so the trader on our leg is the signed-in admin
      trader: name || short(isLong ? f.trader_long : f.trader_short),
      cpty: short(isLong ? f.inst_short : f.inst_long),
      notional: fromUnits(f.notional_6dp ?? "0"),
      entry: fromUnits(f.entry_price ?? "0"),
      mark: fromUnits(f.last_mark ?? f.entry_price ?? "0"),
      im: fromUnits(f.im_each ?? "0"),
      maturity: tenorLabel(Number(f.expiry_ms ?? "0")),
      venue: "DeepBook",
      otcId: o.data!.objectId,
      status: Number(f.status ?? "0"),
    });
  }
  return rows;
}

/** Per-contract cross-margin health for the margin panel: live status, whether
 *  the MM buffer is breached at the current oracle mark, and a pending
 *  margin-call deadline (ms) if one is recorded. */
export type ContractHealth = {
  otcId: string;
  status: number; // 0 active · 1 settled · 2 liquidated
  breached: boolean;
  callDeadlineMs: number | null;
};

export async function readContractsHealth(otcIds: string[]): Promise<ContractHealth[]> {
  if (!otcIds.length) return [];
  const tx = new Transaction();
  for (const id of otcIds) {
    tx.moveCall({
      target: TARGET.otc.mmBreached,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(id), tx.object(SHARED.riskOracle), tx.object(CLOCK)],
    });
    tx.moveCall({
      target: TARGET.otc.marginCallDeadline,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(id)],
    });
  }
  const [r, objs] = await Promise.all([
    suiRead.devInspectTransactionBlock({ sender: READER, transactionBlock: tx }),
    suiRead.multiGetObjects({ ids: otcIds, options: { showContent: true } }),
  ]);
  return otcIds.map((otcId, i) => {
    const breached = (r.results?.[2 * i]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
    // Option<u64> BCS: [0] = none · [1, 8 bytes LE] = some(deadline)
    const ob = (r.results?.[2 * i + 1]?.returnValues?.[0]?.[0] ?? []) as number[];
    const callDeadlineMs = ob[0] === 1 ? Number(decodeU64(ob.slice(1, 9))) : null;
    const f = (objs[i]?.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    return { otcId, status: Number(f?.status ?? "0"), breached, callDeadlineMs };
  });
}

/** Resolve proposed direct offers that the counterparty has since accepted:
 *  returns (offerId → the opened OtcForward id) for every accepted offer. */
export async function readAcceptedOffers(offerIds: string[]): Promise<{ offerId: string; otcId: string }[]> {
  if (!offerIds.length) return [];
  const objs = await suiRead.multiGetObjects({ ids: offerIds, options: { showContent: true } });
  const out: { offerId: string; otcId: string }[] = [];
  for (const o of objs) {
    const f = (o.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
    if (!f) continue;
    // Option<ID> renders as null (none) or the id string / {Some: id}
    const raw = f.accepted_otc as string | { Some?: string } | null | undefined;
    const otcId = typeof raw === "string" ? raw : raw?.Some;
    if (otcId) out.push({ offerId: o.data!.objectId, otcId });
  }
  return out;
}

/** On-chain liquidity floor (router policy): liquid treasury may never be
 *  deployed below `floor`; `deployable` = liquid − floor. Defaults apply if
 *  the institution never customised its RehypoConfig. */
export async function readFloor(instId: string): Promise<{ floor: number; deployable: number }> {
  const tx = new Transaction();
  tx.moveCall({
    target: TARGET.router.requiredFloor,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(instId)],
  });
  tx.moveCall({
    target: TARGET.router.deployable,
    typeArguments: [DBUSDC_TYPE],
    arguments: [tx.object(instId)],
  });
  const r = await suiRead.devInspectTransactionBlock({ sender: READER, transactionBlock: tx });
  return {
    floor: Number(decodeU64(r.results?.[0]?.returnValues?.[0]?.[0] as number[] | undefined)) / 1e6,
    deployable: Number(decodeU64(r.results?.[1]?.returnValues?.[0]?.[0] as number[] | undefined)) / 1e6,
  };
}

export type OracleState = { mark: number; triggered: boolean };

/** SPCX oracle mark + trigger flag. Falls back to the seed mark if no feed yet. */
export async function readOracle(symbol = SPCX.symbol): Promise<OracleState> {
  const tx = new Transaction();
  tx.moveCall({ target: TARGET.oracle.hasFeed, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(symbol)] });
  tx.moveCall({ target: TARGET.oracle.price, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(symbol)] });
  tx.moveCall({ target: TARGET.oracle.isTriggered, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(symbol)] });
  try {
    const r = await suiRead.devInspectTransactionBlock({ sender: READER, transactionBlock: tx });
    const has = (r.results?.[0]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
    if (!has) return { mark: SPCX.initialMark, triggered: false };
    const mark = Number(decodeU64(r.results?.[1]?.returnValues?.[0]?.[0] as number[] | undefined)) / 1e6;
    const triggered = (r.results?.[2]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
    return { mark, triggered };
  } catch {
    return { mark: SPCX.initialMark, triggered: false };
  }
}
