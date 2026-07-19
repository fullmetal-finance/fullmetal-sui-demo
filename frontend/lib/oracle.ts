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
  clearedCalls?: string[]; // reset: stale margin calls defused (healthy-path crank)
  stillCalled?: string[]; // reset: contracts still breached+called — NOT defused
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

/** Reset SPCX to the nominal mark, untriggered, EWMA re-seeded — clean stage.
 *  Pass the desk's open contracts: any STALE margin call on them (pending call
 *  on a now-healthy position) is defused with a healthy-path crank, so a later
 *  crash gets a fresh 90s cure window instead of instant liquidation. */
export const resetOracle = (otcIds?: string[]) => postOracle({ action: "reset", otcIds });

/** Push a mark without the recall sequence (manual mode). */
export const setMark = (price: number) => postOracle({ action: "push", price });

export const oracleStatus = (instId?: string) => postOracle({ action: "status", instId });

/** Human wording for the Move aborts a demo can surface client-side. */
export function friendlyMoveError(msg: string): string {
  if (msg.includes("abort code: 77")) return "margin-call cure window still running — the position can only pay or wait";
  if (msg.includes("abort code: 73")) return "position is healthy — nothing to crank";
  if (msg.includes("abort code: 78")) return "contract is past expiry — settle it via close";
  if (msg.includes("abort code: 63")) return "risk trigger is no longer active";
  if (msg.includes("abort code: 25")) return "deploy exceeds the locked IM — only locked margin is rehypothecated (free liquidity stays in the treasury)";
  if (msg.includes("abort code: 24")) return "deploy would breach the on-chain liquidity floor";
  if (msg.includes("abort code: 23")) return "not enough liquid treasury — funds are deployed at a venue; recall first";
  if (msg.includes("abort code: 22")) return "insufficient free treasury for this amount (reserved IM cannot be spent)";
  if (msg.includes("rejected as invalid by more than 1/3")) return "keeper transactions overlapped — retrying next tick (they are serialized now; this should not recur)";
  if (msg.includes("abort code: 90")) return "this RFQ is already filled or closed — the winning quote opened a contract; the other quotes are void";
  if (msg.includes("abort code: 91")) return "the RFQ has expired — broadcast a new one";
  if (msg.includes("abort code: 93")) return "that quote is no longer live (withdrawn, already accepted, or reclaimed)";
  if (msg.includes("abort code: 94")) return "that quote's TTL has passed — a fresh quote is needed";
  return msg;
}
