"use client";

import { useState } from "react";

import { usd } from "@/lib/fullmetal";

const PRESETS = [50, 100, 250];

/** Mock fiat on-ramp. The "card" is cosmetic; under the hood it faucets DBUSDC
 *  and gaslessly deposits it into the institution treasury (USD → USDC). */
export default function LoadUsdModal({
  open,
  onClose,
  fund,
}: {
  open: boolean;
  onClose: () => void;
  fund: (amount: number) => Promise<void>;
}) {
  const [amount, setAmount] = useState(50);
  const [phase, setPhase] = useState<"idle" | "processing" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function submit() {
    setError(null);
    setPhase("processing");
    try {
      await fund(amount);
      setPhase("done");
      setTimeout(() => {
        onClose();
        setPhase("idle");
      }, 1100);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-12" onClick={onClose}>
      <div className="w-full max-w-[460px] rounded-[18px] border border-line-strong bg-surface p-7" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">Treasury · on-ramp</p>
            <h2 className="mt-1.5 text-[19px] font-semibold tracking-[-0.01em]">Add funds</h2>
          </div>
          <button onClick={onClose} className="text-[20px] text-muted hover:text-ink">×</button>
        </div>

        {/* mock card */}
        <div className="mt-6 rounded-[14px] border border-line-strong bg-gradient-to-br from-ink to-[#2a2a2a] p-5 text-bg">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] opacity-70">Corporate · USD</span>
            <span className="h-5 w-7 rounded-[3px] bg-bg/25" />
          </div>
          <p className="mt-7 font-mono text-[16px] tracking-[0.2em]">•••• •••• •••• 4242</p>
          <div className="mt-3 flex items-center justify-between font-mono text-[11px] opacity-80">
            <span>{/* treasury account */}FULLMETAL TREASURY</span>
            <span>12/29</span>
          </div>
        </div>

        {/* amount */}
        <div className="mt-6">
          <p className="text-[12px] font-medium text-ink-soft">Amount</p>
          <div className="mt-2 flex items-center gap-2">
            <div className="flex flex-1 items-center rounded-[8px] border border-line-strong bg-bg px-3">
              <span className="text-[18px] text-muted">$</span>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(Math.max(1, +e.target.value))}
                className="w-full bg-transparent px-1 py-2.5 font-mono text-[18px] font-semibold text-ink outline-none"
              />
            </div>
            {PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => setAmount(p)}
                className={`rounded-[8px] border px-3 py-2.5 text-[13px] font-medium transition-colors ${amount === p ? "border-line-strong bg-ink text-bg" : "border-line text-ink hover:bg-bg"}`}
              >
                ${p}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-line pt-4 text-[13px]">
          <span className="text-muted">You receive</span>
          <span className="font-mono font-semibold text-ink">{usd(amount)} DBUSDC</span>
        </div>

        <button
          onClick={submit}
          disabled={phase === "processing"}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-[9px] border border-line-strong bg-ink px-4 py-3.5 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {phase === "processing" ? (
            <><Spinner /> Processing…</>
          ) : phase === "done" ? (
            "✓ Funded"
          ) : (
            `Add ${usd(amount)} →`
          )}
        </button>
        <p className="mt-3 text-center text-[11px] leading-[1.6] text-muted">
          Demo on-ramp · settles to USDC on Sui · gas sponsored
        </p>
        {error && <p className="mt-2 break-words text-[12px] text-[#b4341f]">{error}</p>}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-bg/40 border-t-bg" />
  );
}
