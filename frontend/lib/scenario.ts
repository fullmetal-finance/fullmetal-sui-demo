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
  // staged event prints (multiplicative returns), consumed one per tick
  let queue: { ret: number; vol: number }[] = [];

  // Print magnitude bounded to [0.6, 1.8]× the vol regime (random sign): keeps
  // the on-chain EWMA σ from collapsing in quiet stretches, where an ordinary
  // print would read as a multi-σ "shock" and false-latch the trigger
  // (max/min magnitude ratio 3 ⇒ worst-case z ≈ 2, safely under the 4σ latch).
  const draw = () => (Math.random() < 0.5 ? -1 : 1) * (0.6 + 1.2 * Math.random());
  const round = (p: number) => Math.max(0.01, Math.round(p * 100) / 100);

  return {
    inject(kind: MarketEventKind) {
      if (kind === "crash") {
        // PRE-EMPTED crash — how real crashes arrive (vol clusters): tremors
        // first. The first −3…4% print is already a z ≫ 4σ shock against a
        // calm ~50 bps regime, so the trigger latches and the permissionless
        // recall brings collateral home BEFORE the main move two prints later.
        // Cumulative −19…21%.
        queue = [
          { ret: -(0.03 + Math.random() * 0.01), vol: 220 }, // tremor: latch + recall
          { ret: -(0.04 + Math.random() * 0.01), vol: 360 }, // escalation
          { ret: -(0.12 + Math.random() * 0.012), vol: 520 }, // the main leg — money already out
        ];
        pending = null;
        return;
      }
      if (kind === "spike") {
        // Gradual squeeze UP, same clustering as a crash but upward. The EWMA
        // is symmetric (|return|), so the first +3…4% print is a z ≫ 4σ shock
        // that latches the trigger and recalls collateral BEFORE the +12…13%
        // main leg. Cumulative +19…21%.
        queue = [
          { ret: +(0.03 + Math.random() * 0.01), vol: 220 }, // tremor: latch + recall
          { ret: +(0.04 + Math.random() * 0.01), vol: 360 }, // escalation
          { ret: +(0.12 + Math.random() * 0.012), vol: 520 }, // the main squeeze — money already out
        ];
        pending = null;
        return;
      }
      pending = kind; // "calm"
    },
    vol: () => Math.round(volBps),
    next(): number {
      if (queue.length) {
        const step = queue.shift()!;
        level = level * (1 + step.ret);
        anchor = level;
        volBps = step.vol;
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
