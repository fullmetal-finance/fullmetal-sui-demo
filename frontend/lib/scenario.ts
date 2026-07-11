/* Scripted oracle price paths for the demo scenario player. Each tick is a
   REAL on-chain `push_price_v2` (keeper-signed, server route) — the chart
   reacts to chain state, never to these arrays. The paths were designed
   against a bit-exact offline replica of oracle.move's integer EWMA math and
   the flash-crash path is verified on live testnet (scripts/vol-smoke.ts):
   with the SPCX calibration (seed σ150bps, λ0.60, z*4.0, ceil 800bps,
   θ0.70, N=3) latch/release land on the ticks below.

   `expect` is annotation metadata for pre-flight labels only — markers on the
   chart are drawn from actual on-chain transitions. */

export type ScenarioKey = "flash-crash" | "melt-up" | "calm-drift";

export type Scenario = {
  key: ScenarioKey;
  label: string;
  blurb: string;
  /** USD marks pushed on-chain, in order. Runs from the $185 nominal mark. */
  prices: number[];
  /** Minimum ms between ticks (a tick also waits for its tx to confirm). */
  cadenceMs: number;
  expect: { latchTick: number | null; releaseTick: number | null };
};

export const NOMINAL_MARK = 185;

export const SCENARIOS: Scenario[] = [
  {
    key: "flash-crash",
    label: "Flash crash",
    blurb: "−20% gap down, violent chop, then stabilisation at the lower level",
    prices: [184.6, 185.3, 184.9, 148.0, 152.5, 147.8, 151.2, 149.6, 150.4, 150.1, 150.6, 151.4],
    cadenceMs: 1200,
    expect: { latchTick: 4, releaseTick: 10 },
  },
  {
    key: "melt-up",
    label: "Melt-up",
    blurb: "+25% spike (short squeeze), chop at the highs, then calm",
    prices: [185.4, 184.8, 231.2, 228.4, 230.0, 229.0, 229.4, 229.1, 229.3, 229.5],
    cadenceMs: 1200,
    expect: { latchTick: 3, releaseTick: 10 },
  },
  {
    key: "calm-drift",
    label: "Calm drift",
    blurb: "Ordinary two-way noise — never latches, collateral keeps earning",
    prices: [185.5, 184.9, 185.8, 185.2, 186.0, 185.4, 185.9, 185.6, 186.1, 185.8],
    cadenceMs: 1200,
    expect: { latchTick: null, releaseTick: null },
  },
];

export function scenarioByKey(key: ScenarioKey): Scenario {
  return SCENARIOS.find((s) => s.key === key) ?? SCENARIOS[0];
}

/* ------------------------------------------------------------------ */
/*  Live market simulator — a continuous ticker that FEELS like a real */
/*  feed: gentle mean-reverting drift in calm, injectable crash/spike  */
/*  events followed by decaying turbulence, then organic stabilisation.*/
/*  The on-chain EWMA reacts naturally: the gap print latches (z ≫ 4σ),*/
/*  the decaying chop keeps σ above the release band for a few prints, */
/*  and ~3 calm prints after σ decays the latch auto-releases.         */
/* ------------------------------------------------------------------ */

export type MarketEventKind = "crash" | "spike" | "calm";

export type MarketSim = {
  /** queue a regime event; it lands on the next tick */
  inject: (kind: MarketEventKind) => void;
  /** produce the next print (USD) */
  next: () => number;
  /** current turbulence level, bps/print (for UI hints) */
  vol: () => number;
};

export function createMarketSim(startPrice: number): MarketSim {
  let level = startPrice;
  let anchor = startPrice; // post-event equilibrium the drift reverts toward
  let volBps = 42; // print-vol regime; decays back to calm after events
  let pending: MarketEventKind | null = null;

  // Print magnitude bounded to [0.6, 1.8]× the vol regime (random sign): keeps
  // the on-chain EWMA σ from collapsing in quiet stretches, where an ordinary
  // print would read as a multi-σ "shock" and false-latch the trigger
  // (max/min magnitude ratio 3 ⇒ worst-case z ≈ 2, safely under the 4σ latch).
  const draw = () => (Math.random() < 0.5 ? -1 : 1) * (0.6 + 1.2 * Math.random());
  const round = (p: number) => Math.max(0.01, Math.round(p * 100) / 100);

  return {
    inject(kind: MarketEventKind) {
      pending = kind;
    },
    vol: () => Math.round(volBps),
    next(): number {
      if (pending === "crash") {
        pending = null;
        level = level * (1 - (0.18 + Math.random() * 0.04)); // −18…22% gap
        anchor = level;
        volBps = 520; // violent aftermath, decays below
        return round(level);
      }
      if (pending === "spike") {
        pending = null;
        level = level * (1 + (0.18 + Math.random() * 0.05)); // +18…23% squeeze
        anchor = level;
        volBps = 520;
        return round(level);
      }
      if (pending === "calm") {
        pending = null;
        volBps = 42;
      }
      volBps = Math.max(40, volBps * 0.78); // turbulence half-life ≈ 3 prints
      const shock = (draw() * volBps) / 10_000;
      const pull = ((anchor - level) / level) * 0.06; // gentle mean reversion
      level = level * (1 + shock + pull);
      return round(level);
    },
  };
}
