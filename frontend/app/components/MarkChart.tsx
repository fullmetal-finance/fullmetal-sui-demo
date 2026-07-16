"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { SPCX, usd } from "@/lib/fullmetal";
import { oracleStatus } from "@/lib/oracle";

/* SPCX daily market chart — Nasdaq-style candles from the 2026-06-12 IPO
   (priced $135, first-day close ≈$150) through today. The history is a
   deterministic seeded series (same shape every load); TODAY's candle is
   LIVE — its close tracks the keeper mark the contracts actually settle on
   (polled every 4s), so during a crash demo the daily chart prints the red
   candle in real time and the chart can never disagree with the settle mark.

   Compact card (drop into any form) → click ⤢ → full-screen overlay with
   axes, volume, and a hover OHLC tooltip. */

type Candle = { date: Date; o: number; h: number; l: number; c: number; v: number; live?: boolean };

const IPO_DATE = new Date(2026, 5, 12); // 2026-06-12 (month is 0-based)
const IPO_PRICE = 135;
const DAY1_CLOSE = 150.4; // first-day pop

// deterministic PRNG so the history has the same shape every load
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function tradingDays(from: Date, to: Date): Date[] {
  const days: Date[] = [];
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  while (d <= end) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

/** Seeded daily history from the IPO to YESTERDAY, geometrically bridged so
 *  the last historical close lands just under the nominal mark — then today's
 *  live candle opens there and closes at the live keeper mark. */
function buildHistory(today: Date): Candle[] {
  const days = tradingDays(IPO_DATE, today);
  if (days.length <= 1) return [];
  const hist = days.slice(0, -1); // everything before today
  const rnd = mulberry32(0x5b0a11);

  // raw walk: day-1 pop, then choppy dailies with light mean reversion
  const closes: number[] = [DAY1_CLOSE];
  for (let i = 1; i < hist.length; i++) {
    const rev = (DAY1_CLOSE - closes[i - 1]) / DAY1_CLOSE;
    const ret = (rnd() - 0.5) * 0.042 + rev * 0.06;
    closes.push(closes[i - 1] * (1 + ret));
  }
  // geometric bridge so the eve-of-today close sits just under the nominal
  // mark — preserves the local shape, pins the endpoint
  const target = SPCX.initialMark * 0.999;
  const corr = target / closes[closes.length - 1];
  const bridged = closes.map((c, i) => (i === 0 ? c : c * Math.pow(corr, i / (closes.length - 1))));

  return hist.map((date, i) => {
    const o = i === 0 ? IPO_PRICE : bridged[i - 1];
    const c = bridged[i];
    const wick = 0.002 + rnd() * 0.011;
    const h = Math.max(o, c) * (1 + wick);
    const l = Math.min(o, c) * (1 - (0.002 + rnd() * 0.011));
    const ret = Math.abs(c - o) / o;
    const v = (i === 0 ? 46 : 7 + rnd() * 8) * (1 + 9 * ret);
    return { date, o, h, l, c, v };
  });
}

function liveCandle(prev: Candle | undefined, mark: number | null, today: Date): Candle {
  const o = prev?.c ?? IPO_PRICE;
  const c = mark && mark > 0 ? mark : o;
  const rnd = mulberry32(today.getDate() * 97 + today.getMonth());
  return {
    date: today,
    o,
    h: Math.max(o, c) * (1 + 0.002 + rnd() * 0.004),
    l: Math.min(o, c) * (1 - 0.002 - rnd() * 0.004),
    c,
    v: 6 + rnd() * 5 + 60 * (Math.abs(c - o) / o),
    live: true,
  };
}

const fmtDay = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

export default function MarkChart({
  symbol = "SPCX",
  label = "SpaceX",
}: {
  symbol?: string;
  label?: string;
  caption?: string; // kept for call-site compatibility
}) {
  const [mark, setMark] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const s = await oracleStatus();
        if (alive) setMark(s.mark);
      } catch {
        /* transient */
      }
    };
    read();
    const t = setInterval(read, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const dayKey = new Date().toDateString();
  const history = useMemo(() => buildHistory(new Date()), [dayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const candles = useMemo(
    () => [...history, liveCandle(history[history.length - 1], mark, new Date())],
    [history, mark, dayKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const last = candles[candles.length - 1];
  const dToday = last.o > 0 ? ((last.c - last.o) / last.o) * 100 : 0;
  const up = dToday >= 0;
  const tone = up ? "#1a6042" : "#9a2c1a";

  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        title="expand the chart"
        className="block w-full rounded-[10px] border-[0.5px] border-line bg-bg px-3.5 pb-2.5 pt-3 text-left transition-colors hover:border-line-strong"
      >
        <div className="flex items-baseline gap-2 font-mono text-[12px]">
          <span className="fm-pulse h-[6px] w-[6px] self-center rounded-full" style={{ background: "#1f6f4d" }} />
          <span className="font-semibold text-ink">{symbol}</span>
          <span className="text-muted">Nasdaq · daily</span>
          <span className="text-[15px] font-semibold text-ink">{mark != null ? usd(last.c) : "—"}</span>
          <span className="text-[11px] font-semibold" style={{ color: tone }}>
            {up ? "▲" : "▼"} {Math.abs(dToday).toFixed(2)}% today
          </span>
          <span className="ml-auto text-[11px] text-faint">⤢ expand</span>
        </div>
        <div className="mt-2">
          <CandleChart candles={candles} height={118} compact />
        </div>
        <p className="mt-1.5 text-[10.5px] text-faint">
          since the {fmtDay(IPO_DATE)} IPO (priced ${IPO_PRICE}) · today&apos;s candle is live — it closes at the mark your contract settles on
        </p>
      </button>

      {expanded && (
        <Expanded symbol={symbol} label={label} candles={candles} mark={mark} dToday={dToday} tone={tone} onClose={() => setExpanded(false)} />
      )}
    </>
  );
}

/* ---- expanded full-screen overlay ---- */

function Expanded({
  symbol,
  label,
  candles,
  mark,
  dToday,
  tone,
  onClose,
}: {
  symbol: string;
  label: string;
  candles: Candle[];
  mark: number | null;
  dToday: number;
  tone: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const last = candles[candles.length - 1];
  const hi = Math.max(...candles.map((k) => k.h));
  const lo = Math.min(...candles.map((k) => k.l));

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 py-8"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        className="flex max-h-full w-full max-w-[1020px] flex-col rounded-[16px] border-[0.5px] border-line-strong bg-surface p-6 sm:p-7"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="fm-pulse h-[7px] w-[7px] self-center rounded-full" style={{ background: "#1f6f4d" }} />
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
            {symbol} <span className="font-normal text-muted">· {label} — Nasdaq · daily</span>
          </h2>
          <span className="font-mono text-[22px] font-semibold text-ink">{mark != null ? usd(last.c) : "—"}</span>
          <span className="font-mono text-[13px] font-semibold" style={{ color: tone }}>
            {dToday >= 0 ? "▲" : "▼"} {Math.abs(dToday).toFixed(2)}% <span className="font-normal text-faint">today</span>
          </span>
          <button onClick={onClose} className="ml-auto text-[20px] leading-none text-muted hover:text-ink" title="close (Esc)">
            ×
          </button>
        </div>

        <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[12px] text-muted">
          <span>IPO <span className="text-ink">{usd(IPO_PRICE)}</span> · {fmtDay(IPO_DATE)}</span>
          <span>since IPO <span className="text-ink">{(((last.c - IPO_PRICE) / IPO_PRICE) * 100).toFixed(1)}%</span></span>
          <span>high <span className="text-ink">{usd(hi)}</span></span>
          <span>low <span className="text-ink">{usd(lo)}</span></span>
          <span>sessions <span className="text-ink">{candles.length}</span></span>
        </div>

        <div className="mt-4 min-h-0 flex-1">
          <CandleChart candles={candles} height={460} withAxes withHover />
        </div>

        <p className="mt-3 font-mono text-[10.5px] leading-[1.6] text-faint">
          {symbol} listed on Nasdaq {fmtDay(IPO_DATE)}, 2026 (IPO ${IPO_PRICE}) · today&apos;s candle is live — its close is the
          Fullmetal keeper mark, the level every contract settles against.
        </p>
      </div>
    </div>
  );
}

/* ---- candlestick renderer (SVG, shared by compact + expanded) ---- */

function CandleChart({
  candles,
  height,
  compact,
  withAxes,
  withHover,
}: {
  candles: Candle[];
  height: number;
  compact?: boolean;
  withAxes?: boolean;
  withHover?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 960;
  const H = height;
  const AXIS = withAxes ? 56 : 0;
  const XLBL = withAxes ? 20 : 0;
  const VOL_H = compact ? 0 : Math.round(H * 0.13); // volume strip (expanded only)
  const plotW = W - AXIS;
  const plotH = H - XLBL - VOL_H;

  const hi = Math.max(...candles.map((k) => k.h));
  const lo = Math.min(...candles.map((k) => k.l));
  const span = Math.max(hi - lo, hi * 0.002, 1e-9);
  const top = hi + span * 0.06;
  const bot = lo - span * 0.06;
  const maxV = Math.max(...candles.map((k) => k.v));

  const n = candles.length;
  const slot = plotW / n;
  const bw = Math.max(2, Math.min(slot * 0.62, 26)); // candle body width
  const x = (i: number) => slot * i + slot / 2;
  const y = (p: number) => ((top - p) / (top - bot)) * plotH;

  const onMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const fx = ((e.clientX - rect.left) / rect.width) * W;
      setHover(Math.max(0, Math.min(n - 1, Math.floor(fx / slot))));
    },
    [n, slot],
  );

  const gridPrices = withAxes ? [0, 1, 2, 3].map((k) => bot + ((top - bot) * (k + 0.5)) / 4) : [];
  const dateIdx = withAxes ? [0, 1, 2, 3].map((k) => Math.round(((n - 1) * k) / 3)) : [];
  const h = hover != null && withHover ? candles[hover] : null;
  const last = candles[n - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio={compact ? "none" : "xMidYMid meet"}
      className="block w-full select-none"
      style={compact ? { height: H } : undefined}
      onMouseMove={withHover ? onMove : undefined}
      onMouseLeave={withHover ? () => setHover(null) : undefined}
    >
      {/* price gridlines + right labels */}
      {gridPrices.map((p, i) => (
        <g key={i}>
          <line x1={0} x2={plotW} y1={y(p)} y2={y(p)} stroke="var(--color-line, #e4e0d8)" strokeDasharray="3 5" strokeWidth="1" />
          <text x={plotW + 8} y={y(p) + 3.5} fontSize="11" fontFamily="var(--font-mono, monospace)" fill="var(--color-muted, #8a857b)">
            {p.toFixed(0)}
          </text>
        </g>
      ))}
      {/* date labels */}
      {dateIdx.map((i, k) => (
        <text
          key={k}
          x={x(i)}
          y={H - 5}
          fontSize="11"
          fontFamily="var(--font-mono, monospace)"
          fill="var(--color-muted, #8a857b)"
          textAnchor={k === 0 ? "start" : k === 3 ? "end" : "middle"}
        >
          {fmtDay(candles[i].date)}
        </text>
      ))}

      {/* volume strip */}
      {VOL_H > 0 &&
        candles.map((k, i) => {
          const vh = (k.v / maxV) * (VOL_H - 4);
          return (
            <rect
              key={`v${i}`}
              x={x(i) - bw / 2}
              y={plotH + (VOL_H - vh)}
              width={bw}
              height={vh}
              fill={k.c >= k.o ? "rgba(26,96,66,0.28)" : "rgba(154,44,26,0.28)"}
            />
          );
        })}

      {/* last-price dashed rule */}
      <line x1={0} x2={plotW} y1={y(last.c)} y2={y(last.c)} stroke={last.c >= last.o ? "#1a6042" : "#9a2c1a"} strokeDasharray="2 4" strokeWidth="1" opacity="0.55" />
      {withAxes && (
        <g transform={`translate(${plotW + 2}, ${y(last.c) - 9})`}>
          <rect width={AXIS - 4} height="18" rx="4" fill={last.c >= last.o ? "#1a6042" : "#9a2c1a"} />
          <text x={(AXIS - 4) / 2} y="12.5" fontSize="11" fontFamily="var(--font-mono, monospace)" fontWeight="700" fill="#fff" textAnchor="middle">
            {last.c.toFixed(2)}
          </text>
        </g>
      )}

      {/* candles */}
      {candles.map((k, i) => {
        const green = k.c >= k.o;
        const col = green ? "#1a6042" : "#9a2c1a";
        const bodyTop = y(Math.max(k.o, k.c));
        const bodyH = Math.max(1.4, Math.abs(y(k.o) - y(k.c)));
        return (
          <g key={i} opacity={hover != null && hover !== i && withHover ? 0.55 : 1}>
            <line x1={x(i)} x2={x(i)} y1={y(k.h)} y2={y(k.l)} stroke={col} strokeWidth="1.2" />
            <rect x={x(i) - bw / 2} y={bodyTop} width={bw} height={bodyH} fill={green ? col : col} rx="1" />
            {k.live && (
              <circle cx={x(i)} cy={y(k.c)} r="3" fill={col} stroke="var(--color-surface, #fff)" strokeWidth="1.2">
                <animate attributeName="opacity" values="1;0.35;1" dur="1.6s" repeatCount="indefinite" />
              </circle>
            )}
          </g>
        );
      })}

      {/* hover crosshair + OHLC tooltip */}
      {h && hover != null && (
        <g pointerEvents="none">
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={plotH + VOL_H} stroke="var(--color-ink, #221f1a)" strokeWidth="1" opacity="0.3" />
          <g transform={`translate(${Math.min(x(hover) + 12, plotW - 178)}, 8)`}>
            <rect width="170" height="52" rx="6" fill="var(--color-surface, #ffffff)" stroke="var(--color-line-strong, #c9c4b8)" strokeWidth="0.8" />
            <text x="10" y="16" fontSize="11" fontFamily="var(--font-mono, monospace)" fontWeight="700" fill="var(--color-ink, #221f1a)">
              {fmtDay(h.date)}{h.live ? " · live" : ""}
            </text>
            <text x="10" y="31" fontSize="10.5" fontFamily="var(--font-mono, monospace)" fill="var(--color-muted, #8a857b)">
              O {h.o.toFixed(2)}  H {h.h.toFixed(2)}  L {h.l.toFixed(2)}
            </text>
            <text x="10" y="45" fontSize="10.5" fontFamily="var(--font-mono, monospace)" fill={h.c >= h.o ? "#1a6042" : "#9a2c1a"} fontWeight="700">
              C {h.c.toFixed(2)}  ({(((h.c - h.o) / h.o) * 100).toFixed(2)}%)
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
