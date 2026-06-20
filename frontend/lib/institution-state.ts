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
): Promise<import("./mock").MockPosition[]> {
  if (!otcIds.length) return [];
  const objs = await suiRead.multiGetObjects({ ids: otcIds, options: { showContent: true } });
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const rows: import("./mock").MockPosition[] = [];
  for (const o of objs) {
    const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f) continue;
    const isLong = f.inst_long === myInstId;
    rows.push({
      asset: f.underlying ?? "—",
      side: isLong ? "long" : "short",
      trader: short(isLong ? f.trader_long : f.trader_short),
      cpty: short(isLong ? f.inst_short : f.inst_long),
      notional: fromUnits(f.notional_6dp ?? "0"),
      entry: fromUnits(f.entry_price ?? "0"),
      mark: fromUnits(f.last_mark ?? f.entry_price ?? "0"),
      im: fromUnits(f.im_each ?? "0"),
      maturity: f.expiry_ms === "0" ? "perp" : "open",
      venue: "DeepBook",
      otcId: o.data!.objectId,
    });
  }
  return rows;
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
