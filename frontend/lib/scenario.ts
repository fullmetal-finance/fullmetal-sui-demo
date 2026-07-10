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
