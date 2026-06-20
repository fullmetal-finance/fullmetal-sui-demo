"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { DEEPBOOK, SPCX, explorer, usd } from "@/lib/fullmetal";
import type { InstState } from "@/lib/institution-state";
import { readOracle, readSuppliedValue } from "@/lib/institution-state";
import { resetOracle, triggerAndRecall } from "@/lib/oracle";
import { useRecall, useRehypothecate } from "@/lib/rehypo-actions";

type Flow = -1 | 0 | 1;

export default function RehypoHero({
  instId,
  state,
  onRefresh,
}: {
  instId: string;
  state: InstState | null;
  onRefresh: () => void;
}) {
  const rehypothecate = useRehypothecate();
  const recall = useRecall();

  const [supplied, setSupplied] = useState(0);
  const [mark, setMark] = useState<number>(SPCX.initialMark);
  const [triggered, setTriggered] = useState(false);
  const [series, setSeries] = useState<number[]>(() => Array(48).fill(SPCX.initialMark));
  const [flow, setFlow] = useState<Flow>(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [banner, setBanner] = useState(false);
  const [lastDigest, setLastDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // "" = track the live max; a number = the operator's chosen amount
  const [rehypAmt, setRehypAmt] = useState<number | "">("");
  const [recallAmt, setRecallAmt] = useState<number | "">("");
  const [spikePrice, setSpikePrice] = useState<number>(SPCX.spikeMark);

  const liquid = state?.liquid ?? 0;
  const rehyp = state?.rehypothecated ?? 0;
  const reserved = state?.reserved ?? 0; // total posted IM across contracts
  // Only the POSTED IM is rehypothecated — free working capital stays liquid.
  const idleIm = Math.max(0, Math.min(reserved - rehyp, liquid));
  const deployable = Math.floor(idleIm * 100) / 100;
  const pctDeployed = reserved > 0 ? Math.min(1, rehyp / reserved) : 0;
  const interest = Math.max(0, supplied - rehyp);
  const rehypValue = rehypAmt === "" ? deployable : rehypAmt;
  const recallValue = recallAmt === "" ? Math.floor(rehyp * 100) / 100 : recallAmt;

  const poll = useCallback(async () => {
    try {
      const [sv, oc] = await Promise.all([readSuppliedValue(instId), readOracle()]);
      setSupplied(sv);
      setMark(oc.mark);
      setTriggered(oc.triggered);
      setSeries((s) => [...s.slice(1), oc.mark]);
    } catch {
      /* transient */
    }
  }, [instId]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [poll]);

  async function doRehypothecate() {
    const amt = Math.min(Number(rehypValue) || 0, deployable);
    if (!state || amt <= 0) return;
    setError(null);
    setBusy("deploy");
    setFlow(1);
    try {
      const digest = await rehypothecate(amt);
      setLastDigest(digest);
      setRehypAmt("");
      onRefresh();
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setTimeout(() => setFlow(0), 600);
    }
  }

  async function doTrigger() {
    setError(null);
    setBusy("trigger");
    setBanner(true);
    setFlow(-1);
    try {
      // beat 2: keeper pushes the operator's chosen SPCX mark; if it latches the
      // trigger it runs the permissionless recall, server-side in one sequence.
      const r = await triggerAndRecall(instId, spikePrice);
      setMark(r.mark);
      setTriggered(r.triggered);
      setSeries((s) => [...s.slice(1), r.mark]);
      if (r.recallDigest) setLastDigest(r.recallDigest);
      onRefresh();
      await poll();
      setTimeout(() => setBanner(false), 3000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBanner(false);
    } finally {
      setBusy(null);
      setTimeout(() => setFlow(0), 600);
    }
  }

  async function doRecall() {
    const amt = Math.min(Number(recallValue) || 0, Math.floor(rehyp * 100) / 100);
    if (!state || amt <= 0) return;
    setError(null);
    setBusy("recall");
    setFlow(-1);
    try {
      const digest = await recall(amt);
      setLastDigest(digest);
      setRecallAmt("");
      onRefresh();
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setTimeout(() => setFlow(0), 600);
    }
  }

  async function doCalm() {
    setError(null);
    setBusy("calm");
    try {
      // reset SPCX to its nominal mark + clear, so the next spike actually latches
      const r = await resetOracle();
      setMark(r.mark);
      setTriggered(r.triggered);
      setSeries((s) => [...s.slice(1), r.mark]);
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="relative mt-6 overflow-hidden rounded-[16px] border border-line-strong bg-surface">
      {banner && (
        <div className="fm-banner-in absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 bg-[#b4341f] py-2.5 text-[13px] font-semibold tracking-[0.06em] text-bg">
          ⚠ VOLATILITY TRIGGER · SPCX {fmtPct(SPCX.initialMark, SPCX.spikeMark)} · AUTO-DELEVERAGE
        </div>
      )}

      {/* SPCX mark strip */}
      <div
        className="flex items-center justify-between border-b border-line px-6 py-4"
        style={triggered ? { background: "rgba(180,52,31,0.07)" } : undefined}
      >
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-soft">
            Collateral engine
          </span>
          <span className="text-[12px] text-muted">rehypothecation · oracle recall</span>
        </div>
        <div className="flex items-center gap-4">
          <Spark series={series} triggered={triggered} />
          <div className="text-right">
            <div className="flex items-center justify-end gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{SPCX.symbol}</span>
              <span className={`fm-pulse h-[6px] w-[6px] rounded-full ${triggered ? "bg-[#b4341f]" : "bg-[#1f6f4d]"}`} />
            </div>
            <div className="font-mono text-[22px] font-semibold text-ink">{usd(mark)}</div>
          </div>
        </div>
      </div>

      {/* flow: posted IM in protocol — conduit — IM in DeepBook */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-0 px-6 py-7">
        <Vessel
          label="Posted IM · in protocol"
          big={usd(reserved - rehyp)}
          sub={reserved > 0 ? `of ${usd(reserved)} reserved` : "no contracts yet"}
          pct={reserved > 0 ? (reserved - rehyp) / reserved : 0}
          tone="ink"
        />
        <Conduit flow={flow} />
        <Vessel
          label="DeepBook margin pool"
          big={usd(rehyp)}
          sub={interest > 0 ? `+${usd(interest, { maximumFractionDigits: 4 })} earning` : rehyp > 0 ? "earning yield" : "— idle —"}
          pct={pctDeployed}
          tone="green"
          subGreen={rehyp > 0}
        />
      </div>

      {/* deploy gauge */}
      <div className="px-6 pb-2">
        <div className="relative h-[6px] w-full overflow-hidden rounded-full bg-[rgba(0,0,0,0.07)]">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
            style={{ width: `${pctDeployed * 100}%`, background: flow === -1 ? "#b4341f" : "var(--color-ink)" }}
          />
        </div>
        <p className="mt-2 text-center font-mono text-[11px] tracking-[0.1em] text-muted">
          {Math.round(pctDeployed * 100)}% OF POSTED IM EARNING YIELD IN DEEPBOOK
        </p>
      </div>

      {/* provenance */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-6 py-3 font-mono text-[11px] text-muted">
        <span className="text-[#1f6f4d]">● real, on testnet</span>
        {lastDigest && (
          <a href={explorer.tx(lastDigest)} target="_blank" rel="noreferrer" className="underline hover:text-ink">
            tx {lastDigest.slice(0, 10)}… ↗
          </a>
        )}
        <a href={explorer.object(DEEPBOOK.dbusdcMarginPool)} target="_blank" rel="noreferrer" className="underline hover:text-ink">
          DeepBook pool {DEEPBOOK.dbusdcMarginPool.slice(0, 8)}… ↗
        </a>
      </div>

      {/* controls — choose how much to deploy / recall, and the SPCX mark to push */}
      <div className="space-y-3 border-t border-line bg-bg px-6 py-4">
        <div className="flex items-end gap-2">
          <NumField label={`Deploy · idle ${usd(deployable)}`} value={rehypValue} onChange={(v) => setRehypAmt(v === "" ? "" : +v)} />
          <button onClick={doRehypothecate} disabled={!!busy || deployable <= 0} className="rounded-[7px] border border-line-strong bg-ink px-4 py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90 disabled:opacity-40">
            {busy === "deploy" ? "…" : "Rehypothecate →"}
          </button>
        </div>
        <div className="flex items-end gap-2">
          <NumField label={`Recall · in pool ${usd(rehyp)}`} value={recallValue} onChange={(v) => setRecallAmt(v === "" ? "" : +v)} />
          <button onClick={doRecall} disabled={!!busy || rehyp <= 0} className="rounded-[7px] border border-line-strong px-4 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface disabled:opacity-40">
            {busy === "recall" ? "…" : "Recall →"}
          </button>
        </div>
        <div className="flex items-end gap-2 border-t border-line pt-3">
          <NumField label={`Push SPCX mark · now ${usd(mark)}`} value={spikePrice} onChange={(v) => setSpikePrice(+v || 0)} />
          <button onClick={doTrigger} disabled={!!busy} className="rounded-[7px] border border-[#b4341f] px-4 py-2.5 text-[13px] font-semibold text-[#b4341f] transition-colors hover:bg-[#b4341f] hover:text-bg disabled:opacity-40">
            {busy === "trigger" ? "…" : "Push price →"}
          </button>
          <button onClick={doCalm} disabled={!!busy || !triggered} className="rounded-[7px] border border-line-strong px-4 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface disabled:opacity-40">
            {busy === "calm" ? "…" : "Reset"}
          </button>
        </div>
      </div>

      {error && <p className="break-words px-6 pb-4 text-[12px] text-[#b4341f]">{error}</p>}
    </section>
  );
}

function Vessel({
  label,
  big,
  sub,
  pct,
  tone,
  subGreen,
}: {
  label: string;
  big: string;
  sub: string;
  pct: number;
  tone: "ink" | "green";
  subGreen?: boolean;
}) {
  const edge = tone === "green" ? "#1f6f4d" : "var(--color-ink)";
  const fill = tone === "green" ? "rgba(31,111,77,0.12)" : "rgba(15,15,15,0.07)";
  return (
    <div className="relative flex min-h-[150px] flex-col justify-between overflow-hidden rounded-[12px] border border-line-strong bg-bg p-5">
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 transition-[height] duration-700 ease-out"
        style={{ height: `${Math.min(1, pct) * 100}%`, background: fill, borderTop: `2px solid ${edge}` }}
      />
      <div className="relative">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.13em] text-muted">{label}</p>
      </div>
      <div className="relative">
        <p className="font-mono text-[24px] font-semibold text-ink">{big}</p>
        <p className={`font-mono text-[12px] ${subGreen ? "text-[#1f6f4d]" : "text-muted"}`}>{sub}</p>
      </div>
    </div>
  );
}

function Conduit({ flow }: { flow: Flow }) {
  const cls = flow === 1 ? "fm-flow-right" : flow === -1 ? "fm-flow-left" : "";
  const color = flow === -1 ? "#b4341f" : "var(--color-ink)";
  const caption = flow === 1 ? "DEPLOYING →" : flow === -1 ? "◄ RECALL" : "IDLE";
  return (
    <div className="flex w-[120px] flex-col items-center justify-center px-2">
      <svg width="120" height="40" viewBox="0 0 120 40" aria-hidden>
        <line x1="4" y1="20" x2="116" y2="20" stroke="var(--color-line-strong)" strokeWidth="1" />
        {flow !== 0 && (
          <line
            x1="4"
            y1="20"
            x2="116"
            y2="20"
            stroke={color}
            strokeWidth="2.5"
            strokeDasharray="6 10"
            className={cls}
          />
        )}
      </svg>
      <span className="font-mono text-[10px] tracking-[0.12em]" style={{ color: flow === -1 ? "#b4341f" : "var(--color-muted)" }}>
        {caption}
      </span>
    </div>
  );
}

function Spark({ series, triggered }: { series: number[]; triggered: boolean }) {
  const w = 160;
  const h = 36;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const pts = series
    .map((v, i) => `${(i / (series.length - 1)) * w},${h - ((v - min) / span) * (h - 4) - 2}`)
    .join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="hidden sm:block" aria-hidden>
      <polyline points={pts} fill="none" stroke={triggered ? "#b4341f" : "var(--color-ink)"} strokeWidth="1.5" />
    </svg>
  );
}

function fmtPct(from: number, to: number) {
  const p = ((to - from) / from) * 100;
  return `${p >= 0 ? "+" : ""}${p.toFixed(0)}%`;
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted">{label}</span>
      <div className="flex items-center rounded-[7px] border border-line-strong bg-surface px-2.5">
        <span className="text-[14px] text-muted">$</span>
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent px-1 py-2 font-mono text-[14px] font-semibold text-ink outline-none"
        />
      </div>
    </label>
  );
}
