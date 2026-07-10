"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { SPCX_VOL, usd } from "@/lib/fullmetal";

/* The scenario chart: a live price line (top) + the EWMA σ signal (bottom)
   sharing one x-axis of oracle prints. Every point is a confirmed on-chain
   push; the red/green rules mark the ticks where the RECALL and REDEPOSIT
   actually fired. Hand-rolled SVG in the app's ink-on-paper language:
   2px round-cap lines, ≥8px event dots with a surface ring, hairline grid,
   text in text tokens only. Single series per plot → no legend. */

export type ChartPoint = {
  price: number;
  sigmaBps: number;
  triggered: boolean;
  releaseProgress: number;
};

export type ChartEvent = {
  tick: number; // index into points
  kind: "recall" | "redeposit";
  amount: number; // USD moved (aggregate across venues)
};

const RED = "#b4341f";
const GREEN = "#1f6f4d";

const PAD_L = 10;
const PAD_R = 64;
const PRICE_H = 132;
const GAP_H = 26; // between plots (σ title lives here)
const SIGMA_H = 64;
const TOP = 14;
const BOTTOM = 6;
const HEIGHT = TOP + PRICE_H + GAP_H + SIGMA_H + BOTTOM;

export default function ScenarioChart({
  points,
  events,
  totalTicks,
  frame,
}: {
  points: ChartPoint[];
  events: ChartEvent[];
  /** x-domain size — the scenario's full length so the line grows into a stable frame */
  totalTicks: number;
  /** optional stable y-domain (min/max of the selected scenario path) */
  frame?: { priceMin: number; priceMax: number };
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((es) => {
      const w = es[0]?.contentRect.width;
      if (w) setWidth(Math.max(360, w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = Math.max(totalTicks, points.length, 2);
  const x = (i: number) => PAD_L + (i / (n - 1)) * (width - PAD_L - PAD_R);

  const [pMin, pMax] = useMemo(() => {
    const prices = points.map((p) => p.price);
    let lo = frame ? frame.priceMin : Math.min(...(prices.length ? prices : [0]));
    let hi = frame ? frame.priceMax : Math.max(...(prices.length ? prices : [1]));
    if (prices.length) {
      lo = Math.min(lo, ...prices);
      hi = Math.max(hi, ...prices);
    }
    const pad = Math.max((hi - lo) * 0.12, 1);
    return [lo - pad, hi + pad];
  }, [points, frame]);
  const yPrice = (v: number) => TOP + PRICE_H - ((v - pMin) / (pMax - pMin)) * PRICE_H;

  const sigmaTop = TOP + PRICE_H + GAP_H;
  const sMax = useMemo(() => {
    const m = Math.max(SPCX_VOL.sigmaCeilBps * 1.25, ...points.map((p) => p.sigmaBps * 1.1), 1);
    return m;
  }, [points]);
  const ySigma = (v: number) => sigmaTop + SIGMA_H - (Math.min(v, sMax) / sMax) * SIGMA_H;

  const releaseBandBps = (SPCX_VOL.sigmaCeilBps * SPCX_VOL.thetaRelBps) / 10_000;

  const pricePath = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${yPrice(p.price).toFixed(1)}`).join("");
  const sigmaLine = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${ySigma(p.sigmaBps).toFixed(1)}`).join("");
  const sigmaArea = points.length
    ? `${sigmaLine}L${x(points.length - 1).toFixed(1)},${(sigmaTop + SIGMA_H).toFixed(1)}L${x(0).toFixed(1)},${(sigmaTop + SIGMA_H).toFixed(1)}Z`
    : "";

  // latched span(s): consecutive runs of triggered points → light red wash
  const spans = useMemo(() => {
    const out: [number, number][] = [];
    let start = -1;
    points.forEach((p, i) => {
      if (p.triggered && start < 0) start = i;
      if (!p.triggered && start >= 0) {
        out.push([start, i]);
        start = -1;
      }
    });
    if (start >= 0) out.push([start, points.length - 1]);
    return out;
  }, [points]);

  const last = points[points.length - 1];

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    if (!points.length) return;
    const idx = Math.round(((px - PAD_L) / (width - PAD_L - PAD_R)) * (n - 1));
    setHover(Math.max(0, Math.min(points.length - 1, idx)));
  }

  const hovered = hover != null ? points[hover] : null;
  const priceTicks = niceTicks(pMin, pMax, 3);

  return (
    <div ref={wrapRef} className="relative w-full">
      <svg
        width={width}
        height={HEIGHT}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label="SPCX oracle prints and EWMA volatility with recall and redeposit markers"
      >
        {/* ---- grids (hairline, recessive) ---- */}
        {priceTicks.map((t) => (
          <g key={`pt${t}`}>
            <line x1={PAD_L} y1={yPrice(t)} x2={width - PAD_R} y2={yPrice(t)} stroke="var(--color-line)" strokeWidth="1" />
            <text x={width - PAD_R + 8} y={yPrice(t) + 3.5} className="fill-[var(--color-faint)]" fontSize="10" fontFamily="var(--font-mono)">
              {usd(t, { maximumFractionDigits: 0 })}
            </text>
          </g>
        ))}

        {/* ---- latched span wash (status region, labeled by the markers) ---- */}
        {spans.map(([a, b], i) => (
          <rect key={`sp${i}`} x={x(a)} y={TOP} width={Math.max(x(b) - x(a), 2)} height={PRICE_H + GAP_H + SIGMA_H} fill={RED} opacity="0.055" />
        ))}

        {/* ---- σ plot: ceiling + release rules, area wash + line ---- */}
        <text x={PAD_L} y={sigmaTop - 8} className="fill-[var(--color-muted)]" fontSize="10" fontFamily="var(--font-mono)" letterSpacing="0.08em">
          EWMA σ (bps / print)
        </text>
        <line x1={PAD_L} y1={ySigma(SPCX_VOL.sigmaCeilBps)} x2={width - PAD_R} y2={ySigma(SPCX_VOL.sigmaCeilBps)} stroke={RED} strokeWidth="1" opacity="0.45" strokeDasharray="1 3" />
        <text x={width - PAD_R + 8} y={ySigma(SPCX_VOL.sigmaCeilBps) + 3.5} className="fill-[var(--color-faint)]" fontSize="10" fontFamily="var(--font-mono)">
          σ ceil
        </text>
        <line x1={PAD_L} y1={ySigma(releaseBandBps)} x2={width - PAD_R} y2={ySigma(releaseBandBps)} stroke={GREEN} strokeWidth="1" opacity="0.5" strokeDasharray="1 3" />
        <text x={width - PAD_R + 8} y={ySigma(releaseBandBps) + 3.5} className="fill-[var(--color-faint)]" fontSize="10" fontFamily="var(--font-mono)">
          release
        </text>
        {sigmaArea && <path d={sigmaArea} fill="var(--color-ink)" opacity="0.08" />}
        {sigmaLine && <path d={sigmaLine} fill="none" stroke="var(--color-ink-soft)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

        {/* ---- price line ---- */}
        {pricePath && <path d={pricePath} fill="none" stroke="var(--color-ink)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}

        {/* ---- event markers: rule + ringed dot + label chip ---- */}
        {events.map((ev) => {
          const p = points[ev.tick];
          if (!p) return null;
          const cx = x(ev.tick);
          const isRecall = ev.kind === "recall";
          const color = isRecall ? RED : GREEN;
          const label = isRecall ? `▼ RECALL ${usd(ev.amount, { maximumFractionDigits: 0 })}` : `▲ REDEPOSIT ${usd(ev.amount, { maximumFractionDigits: 0 })}`;
          const flip = cx > width - PAD_R - 150; // keep the chip inside the plot
          return (
            <g key={`${ev.kind}${ev.tick}`}>
              <line x1={cx} y1={TOP - 2} x2={cx} y2={sigmaTop + SIGMA_H} stroke={color} strokeWidth="1" opacity="0.85" />
              <circle cx={cx} cy={yPrice(p.price)} r="6.5" fill={color} stroke="var(--color-surface)" strokeWidth="2" />
              <text
                x={flip ? cx - 7 : cx + 7}
                y={TOP + 9}
                textAnchor={flip ? "end" : "start"}
                fontSize="10.5"
                fontWeight="600"
                fontFamily="var(--font-mono)"
                fill={color}
              >
                {label}
              </text>
            </g>
          );
        })}

        {/* ---- live end-dot ---- */}
        {last && (
          <circle
            cx={x(points.length - 1)}
            cy={yPrice(last.price)}
            r="4.5"
            fill={last.triggered ? RED : "var(--color-ink)"}
            stroke="var(--color-surface)"
            strokeWidth="2"
            className="fm-pulse"
          />
        )}

        {/* ---- crosshair ---- */}
        {hover != null && hovered && (
          <g pointerEvents="none">
            <line x1={x(hover)} y1={TOP} x2={x(hover)} y2={sigmaTop + SIGMA_H} stroke="var(--color-line-strong)" strokeWidth="1" />
            <circle cx={x(hover)} cy={yPrice(hovered.price)} r="4" fill="var(--color-ink)" stroke="var(--color-surface)" strokeWidth="2" />
            <circle cx={x(hover)} cy={ySigma(hovered.sigmaBps)} r="4" fill="var(--color-ink-soft)" stroke="var(--color-surface)" strokeWidth="2" />
          </g>
        )}
      </svg>

      {/* one tooltip, all values at the hovered print */}
      {hover != null && hovered && (
        <div
          className="pointer-events-none absolute z-10 rounded-[7px] border border-line-strong bg-surface px-3 py-2 font-mono text-[11px] leading-[1.7] shadow-sm"
          style={{
            left: Math.min(Math.max(x(hover) + 10, 0), width - 170),
            top: TOP + 6,
          }}
        >
          <div className="text-[10px] uppercase tracking-[0.08em] text-muted">print {hover + 1}</div>
          <div className="text-[13px] font-semibold text-ink">{usd(hovered.price)}</div>
          <div className="text-muted">
            σ {hovered.sigmaBps} bps ·{" "}
            {hovered.triggered ? (
              <span className="font-semibold" style={{ color: RED }}>LATCHED</span>
            ) : (
              <span style={{ color: GREEN }}>calm</span>
            )}
            {hovered.triggered && hovered.releaseProgress > 0 && (
              <span> · release {hovered.releaseProgress}/{SPCX_VOL.releaseNeeded}</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** 2–4 clean ticks inside [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / (count + 1);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? 10 * mag;
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = first; v < hi; v += step) out.push(Number(v.toFixed(6)));
  return out;
}
