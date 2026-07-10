"use client";

import { SPCX } from "./fullmetal";

export type CrankOutcome = { otcId: string; deadline: number | null; status: number };

/** Shape returned by every /api/oracle action (tick adds the recall fields). */
export type OracleResult = {
  mark: number;
  triggered: boolean;
  sigmaBps: number;
  releaseProgress: number;
  rehypothecated: number;
  digest?: string;
  pushDigest?: string;
  recalled?: boolean;
  recalledAmount?: number;
  recallDigest?: string;
  marginCalls?: CrankOutcome[]; // tick with drill contracts armed
  cured?: CrankOutcome[]; // cure action
  error?: string;
};

async function postOracle(body: Record<string, unknown>): Promise<OracleResult> {
  const res = await fetch("/api/oracle", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `oracle ${res.status}`);
  return data as OracleResult;
}

/** One scenario tick: keeper pushes `price` through the EWMA layer. On a
 *  latch: with `otcIds` armed, the server cranks the breached contracts first
 *  (→ margin calls while liquidity is out); otherwise it fires the
 *  permissionless recall immediately. */
export const pushTick = (instId: string, price: number, otcIds?: string[]) =>
  postOracle({ action: "tick", instId, price, otcIds });

/** The cure: permissionless recall + re-crank the called contracts (they pay
 *  from the recalled liquidity and survive). */
export const cureCalls = (instId: string, otcIds: string[]) =>
  postOracle({ action: "cure", instId, otcIds });

/** Manual breach crank of one contract (margin call / pay / liquidate). */
export const crankContract = (otcId: string) =>
  postOracle({ action: "crank", otcIds: [otcId] });

/** Push the SPCX spike (latches the trigger). Keeper-signed, server-side. */
export const triggerSpike = (price: number = SPCX.spikeMark) => postOracle({ action: "push", price });

/** Spike SPCX AND run the permissionless recall on an institution, server-side
 *  in one sequence (no cross-node gas-dry-run race). */
export const triggerAndRecall = (instId: string, price: number = SPCX.spikeMark) =>
  postOracle({ action: "spike", instId, price });

/** Clear the trigger ("volatility subsides"). */
export const calmOracle = () => postOracle({ action: "clear" });

/** Reset SPCX to the nominal mark, untriggered, EWMA re-seeded — clean stage. */
export const resetOracle = () => postOracle({ action: "reset" });

/** Push a mark without the recall sequence (manual mode). */
export const setMark = (price: number) => postOracle({ action: "push", price });

export const oracleStatus = (instId?: string) => postOracle({ action: "status", instId });
