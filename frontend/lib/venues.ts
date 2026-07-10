"use client";

/* Simulated Suilend / Navi supply positions for the collateral manager.
   DeepBook is the REAL leg (testnet margin pool, on-chain txs). Suilend and
   Navi are mainnet-only, so the demo carries them as clearly-badged SIMULATED
   positions: balances live in localStorage per institution, accrue at the
   LIVE mainnet supply APRs from /api/rates, and respond to the same oracle
   trigger/release as the real leg. The supply/withdraw PTBs they stand in for
   are validated against live mainnet in scripts/{suilend,navi}-rehypo.ts. */

export type SimVenueKey = "suilend" | "navi";

export type SimPosition = {
  principal: number; // USD supplied
  depositedAt: number; // ms epoch of last principal change (interest anchor)
  accrued: number; // interest realised into principal on prior changes
};

export type SimVenues = Record<SimVenueKey, SimPosition | null>;

const key = (instId: string) => `fullmetal:simvenues:${instId.toLowerCase()}`;

export function loadSimVenues(instId: string): SimVenues {
  if (typeof window === "undefined") return { suilend: null, navi: null };
  const v = localStorage.getItem(key(instId));
  return v ? (JSON.parse(v) as SimVenues) : { suilend: null, navi: null };
}

function save(instId: string, v: SimVenues): void {
  localStorage.setItem(key(instId), JSON.stringify(v));
}

/** Live value of a sim position at `aprPct` (simple interest since deposit). */
export function simValue(p: SimPosition | null, aprPct: number): number {
  if (!p || p.principal <= 0) return 0;
  const years = Math.max(0, Date.now() - p.depositedAt) / 31_536_000_000;
  return p.principal + p.accrued + p.principal * (aprPct / 100) * years;
}

export function simDeposit(instId: string, venue: SimVenueKey, amount: number, aprPct: number): SimVenues {
  const all = loadSimVenues(instId);
  const cur = all[venue];
  const value = simValue(cur, aprPct);
  all[venue] = {
    principal: (cur?.principal ?? 0) + amount,
    depositedAt: Date.now(),
    accrued: value - (cur?.principal ?? 0), // bank interest earned so far
  };
  save(instId, all);
  return all;
}

/** Withdraw `amount` (or everything if amount ≥ value). Returns what came out. */
export function simWithdraw(instId: string, venue: SimVenueKey, amount: number, aprPct: number): { all: SimVenues; got: number } {
  const all = loadSimVenues(instId);
  const cur = all[venue];
  const value = simValue(cur, aprPct);
  if (!cur || value <= 0) return { all, got: 0 };
  if (amount >= value - 0.005) {
    all[venue] = null;
    save(instId, all);
    return { all, got: value };
  }
  const remaining = value - amount;
  all[venue] = { principal: remaining, depositedAt: Date.now(), accrued: 0 };
  save(instId, all);
  return { all, got: amount };
}

export function simWithdrawAll(instId: string, aprs: Record<SimVenueKey, number>): { all: SimVenues; got: number } {
  const a = simWithdraw(instId, "suilend", Number.POSITIVE_INFINITY, aprs.suilend);
  const b = simWithdraw(instId, "navi", Number.POSITIVE_INFINITY, aprs.navi);
  return { all: b.all, got: a.got + b.got };
}

export function clearSimVenues(instId: string): void {
  if (typeof window !== "undefined") localStorage.removeItem(key(instId));
}
