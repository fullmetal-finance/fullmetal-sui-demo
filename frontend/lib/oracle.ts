"use client";

import { SPCX } from "./fullmetal";

export type OracleResult = { mark: number; triggered: boolean; digest?: string; recalled?: boolean; recallDigest?: string; error?: string };

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

/** Push the SPCX spike (latches the trigger). Keeper-signed, server-side. */
export const triggerSpike = (price: number = SPCX.spikeMark) => postOracle({ action: "push", price });

/** Spike SPCX AND run the permissionless recall on an institution, server-side
 *  in one sequence (no cross-node gas-dry-run race). */
export const triggerAndRecall = (instId: string, price: number = SPCX.spikeMark) =>
  postOracle({ action: "spike", instId, price });

/** Clear the trigger ("volatility subsides"). */
export const calmOracle = () => postOracle({ action: "clear" });

/** Reset SPCX to the nominal mark, untriggered — so the next spike latches. */
export const resetOracle = () => postOracle({ action: "reset" });

/** Ease SPCX back toward a nominal mark (no trigger). */
export const setMark = (price: number) => postOracle({ action: "push", price });

export const oracleStatus = () => postOracle({ action: "status" });
