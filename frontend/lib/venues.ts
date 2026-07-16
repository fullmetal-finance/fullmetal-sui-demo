"use client";

/* Simulated Suilend / Navi supply positions for the collateral manager.
   DeepBook is the REAL leg (testnet margin pool, on-chain txs). Suilend and
   Navi are mainnet-only, so the demo carries them as clearly-badged SIMULATED
   positions: balances live in localStorage per institution, accrue at the
   LIVE mainnet supply APRs from /api/rates, and respond to the same oracle
   trigger/release as the real leg. The supply/withdraw PTBs they stand in for
   are validated against live mainnet in scripts/{suilend,navi}-rehypo.ts.

   ACCOUNTING MODEL (everything must add up, every render):
   `cashOut` is the ledger's spine — the net cash the sim venues have taken
   from the desk's liquid treasury (Σ deposits − Σ withdrawal payouts). The UI
   shows liquid = on-chain liquid − cashOut, so:
     · a deposit moves $X liquid → venue, totals unchanged;
     · interest accrues INSIDE the position (venue value grows, liquid does
       NOT shrink — value − principal is unrealised yield);
     · a withdrawal pays value out through cashOut, so realised interest lands
       in UI liquid instead of evaporating.
   Invariant: UI liquid + Σ sim values = on-chain liquid + unrealised interest. */

export type SimVenueKey = "suilend" | "navi";

export type SimPosition = {
  principal: number; // cost basis: cash moved from liquid into this venue
  accrued: number; // interest folded in on prior deposits/withdrawals
  depositedAt: number; // ms epoch anchor for live interest accrual
};

export type SimVenues = {
  suilend: SimPosition | null;
  navi: SimPosition | null;
  /** net cash the sims hold out of the liquid treasury (see header comment) */
  cashOut: number;
};

const key = (instId: string) => `fullmetal:simvenues:${instId.toLowerCase()}`;

const EMPTY: SimVenues = { suilend: null, navi: null, cashOut: 0 };

export function loadSimVenues(instId: string): SimVenues {
  if (typeof window === "undefined") return { ...EMPTY };
  const v = localStorage.getItem(key(instId));
  if (!v) return { ...EMPTY };
  const parsed = JSON.parse(v) as Partial<SimVenues>;
  // migrate pre-cashOut records: best guess = the stored principals
  const cashOut =
    typeof parsed.cashOut === "number"
      ? parsed.cashOut
      : (parsed.suilend?.principal ?? 0) + (parsed.navi?.principal ?? 0);
  return { suilend: parsed.suilend ?? null, navi: parsed.navi ?? null, cashOut };
}

function save(instId: string, v: SimVenues): void {
  localStorage.setItem(key(instId), JSON.stringify(v));
}

/** Live value of a sim position at `aprPct`: cost basis + folded interest +
 *  simple interest on that base since the last change. */
export function simValue(p: SimPosition | null, aprPct: number): number {
  if (!p) return 0;
  const base = p.principal + p.accrued;
  if (base <= 0) return 0;
  const years = Math.max(0, Date.now() - p.depositedAt) / 31_536_000_000;
  return base + base * (aprPct / 100) * years;
}

/** Unrealised interest sitting inside the position (value − cost basis). */
export function simAccrued(p: SimPosition | null, aprPct: number): number {
  return Math.max(0, simValue(p, aprPct) - (p?.principal ?? 0));
}

export function simDeposit(instId: string, venue: SimVenueKey, amount: number, aprPct: number): SimVenues {
  const all = loadSimVenues(instId);
  if (amount <= 0) return all;
  const cur = all[venue];
  const value = simValue(cur, aprPct);
  all[venue] = {
    principal: (cur?.principal ?? 0) + amount,
    accrued: Math.max(0, value - (cur?.principal ?? 0)), // fold live interest
    depositedAt: Date.now(),
  };
  all.cashOut += amount;
  save(instId, all);
  return all;
}

/** Withdraw `amount` (or everything if amount ≥ value). The payout flows back
 *  through `cashOut`, so realised interest lands in the UI's liquid treasury.
 *  Interest is taken first, then cost basis. Returns what came out. */
export function simWithdraw(instId: string, venue: SimVenueKey, amount: number, aprPct: number): { all: SimVenues; got: number } {
  const all = loadSimVenues(instId);
  const cur = all[venue];
  const value = simValue(cur, aprPct);
  if (!cur || value <= 0) return { all, got: 0 };
  if (amount >= value - 0.005) {
    all[venue] = null;
    all.cashOut -= value;
    save(instId, all);
    return { all, got: value };
  }
  const interest = Math.max(0, value - cur.principal);
  const fromInterest = Math.min(amount, interest);
  const fromPrincipal = amount - fromInterest;
  all[venue] = {
    principal: cur.principal - fromPrincipal,
    accrued: interest - fromInterest,
    depositedAt: Date.now(),
  };
  all.cashOut -= amount;
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
