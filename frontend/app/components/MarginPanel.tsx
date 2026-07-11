"use client";

import { useCallback, useEffect, useState } from "react";

import { usd } from "@/lib/fullmetal";
import type { InstState } from "@/lib/institution-state";
import { readContractsHealth, type ContractHealth } from "@/lib/institution-state";
import type { MockPosition } from "@/lib/mock";
import { crankContract } from "@/lib/oracle";
import { CATEGORICAL, STATUS } from "@/lib/palette";

/* Cross-margin panel — the story in one picture:
   ONE pooled treasury (the full bar) backs EVERY contract. Each contract's
   initial margin is a colored FENCE inside the pool (an accounting hold, the
   coins never move), the green region is free capital, and the red rule is
   Σ maintenance — the level the pool must never be run below. The same fenced
   collateral is simultaneously out earning at venues. Rows below carry each
   contract's live health; a breach shows the margin-call countdown (cure
   window) and the permissionless crank. */

export default function MarginPanel({
  state,
  positions,
  onRefresh,
}: {
  state: InstState | null;
  positions: MockPosition[]; // real on-chain rows (carry otcId)
  onRefresh?: () => void;
}) {
  const real = positions.filter((p) => p.otcId);
  const otcKey = real.map((p) => p.otcId).join(",");
  const [health, setHealth] = useState<Record<string, ContractHealth>>({});
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollHealth = useCallback(async () => {
    const ids = otcKey ? otcKey.split(",") : [];
    if (!ids.length) return;
    try {
      const hs = await readContractsHealth(ids);
      setHealth(Object.fromEntries(hs.map((h) => [h.otcId, h])));
    } catch {
      /* transient */
    }
  }, [otcKey]);

  useEffect(() => {
    pollHealth();
    const t = setInterval(pollHealth, 3000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(t);
      clearInterval(tick);
    };
  }, [pollHealth]);

  async function doCrank(otcId: string) {
    setError(null);
    setBusy(otcId);
    try {
      await crankContract(otcId);
      await pollHealth();
      onRefresh?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const equity = state?.equity ?? 0;
  const reserved = state?.reserved ?? 0;
  const maintenance = state?.totalRequired ?? 0;
  const free = Math.max(0, equity - reserved);
  const isExpired = (p: MockPosition) => (p.expiryMs ?? 0) > 0 && now >= (p.expiryMs ?? 0);
  const liveStatus = (p: MockPosition) => health[p.otcId!]?.status ?? p.status ?? 0;
  const open = real.filter((p) => liveStatus(p) === 0);
  const fenced = open.filter((p) => !isExpired(p)); // expired stay listed below, not fenced… (IM still reserved until closed)

  const pct = (v: number) => (equity > 0 ? Math.min(100, (v / equity) * 100) : 0);
  const color = (i: number) => CATEGORICAL[i % CATEGORICAL.length];

  return (
    <section className="rounded-[14px] border border-line-strong bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-strong px-6 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Cross-margin — one pool backs every trade</h2>
          <p className="mt-0.5 max-w-[520px] text-[12px] leading-[1.55] text-muted">
            The bar is the desk&apos;s whole treasury. Each trade&apos;s initial margin is a colored <b>fence</b> inside it — an
            accounting hold, never a transfer — so free capital (green) and even the fenced margin keep earning at venues.
          </p>
        </div>
        <div className="flex gap-6 font-mono text-[12px]">
          <Stat label="Equity" value={usd(equity)} />
          <Stat label="Fenced IM" value={usd(reserved)} color="#2456c4" />
          <Stat label="Σ maintenance" value={usd(maintenance)} color={STATUS.red} />
          <Stat label="Free" value={usd(free)} color={STATUS.green} />
        </div>
      </div>

      {/* the pooled-treasury bar */}
      <div className="px-6 pb-1 pt-5">
        <div className="relative pb-7 pt-4">
          {/* Σ maintenance flag ABOVE the bar */}
          {maintenance > 0 && (
            <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2" style={{ left: `${pct(maintenance)}%` }}>
              <span className="whitespace-nowrap rounded-[4px] px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-white" style={{ background: STATUS.red }}>
                maintenance floor {usd(maintenance)}
              </span>
            </div>
          )}
          <div className="flex h-[34px] w-full overflow-hidden rounded-[8px]" style={{ background: "rgba(31,111,77,0.14)" }}>
            {fenced.map((p, i) => {
              const w = pct(p.im);
              return (
                <div
                  key={p.otcId}
                  title={`${p.asset} ${p.side.toUpperCase()} vs ${p.cpty} — IM ${usd(p.im)} fenced`}
                  className="flex h-full items-center justify-center overflow-hidden border-r-2 border-surface transition-[width] duration-500"
                  style={{ width: `${w}%`, background: color(i) }}
                >
                  {w > 11 && (
                    <span className="truncate px-1 font-mono text-[10px] font-bold text-white">
                      {p.asset} {usd(p.im, { maximumFractionDigits: 0 })}
                    </span>
                  )}
                </div>
              );
            })}
            <div className="flex h-full flex-1 items-center justify-center" title={`Free capital ${usd(free)} — deployable to venues`}>
              {pct(free) > 14 && (
                <span className="font-mono text-[10px] font-semibold" style={{ color: "#1a6042" }}>
                  free {usd(free, { maximumFractionDigits: 0 })} · earning-eligible
                </span>
              )}
            </div>
          </div>
          {/* maintenance rule through the bar */}
          {maintenance > 0 && (
            <div className="pointer-events-none absolute bottom-7 top-4" style={{ left: `${pct(maintenance)}%` }}>
              <div className="h-full w-[2.5px]" style={{ background: STATUS.red }} />
            </div>
          )}
          <div className="absolute bottom-0 left-0 flex w-full justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            <span>■ fenced IM per contract (colors match the rows below)</span>
            <span>pool equity {usd(equity)}</span>
          </div>
        </div>
      </div>

      {/* per-contract health rows */}
      <div className="divide-y divide-line border-t border-line">
        {real.length === 0 && (
          <p className="px-6 py-4 text-[13px] text-muted">No open contracts yet — accept an RFQ quote or propose a direct trade.</p>
        )}
        {real.map((p, i) => {
          const h = p.otcId ? health[p.otcId] : undefined;
          const status = liveStatus(p);
          const expired = isExpired(p);
          const crankableNow = status === 0 && !expired && (h?.breached || h?.callDeadlineMs != null);
          return (
            <div key={p.otcId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 text-[13px]">
              <span className="h-[12px] w-[12px] shrink-0 rounded-[3px]" style={{ background: status === 0 && !expired ? color(fenced.findIndex((f) => f.otcId === p.otcId)) : "var(--color-line-strong)" }} />
              <div className="flex min-w-[210px] items-center gap-2.5">
                <span className="font-semibold text-ink">{p.asset}</span>
                <span
                  className="rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold"
                  style={p.side === "long" ? { background: "rgba(31,111,77,0.12)", color: "#1a6042" } : { background: "rgba(180,52,31,0.12)", color: "#9a2c1a" }}
                >
                  {p.side.toUpperCase()}
                </span>
                <span className="text-muted">vs {p.cpty}</span>
              </div>
              <span className="font-mono text-muted">
                IM <span className="text-ink">{usd(p.im)}</span>
              </span>
              <span className="font-mono text-muted">
                maint <span className="text-ink">{usd(p.im * 0.7)}</span>
              </span>
              <HealthChip status={status} expired={expired} health={h} now={now} />
              {crankableNow ? (
                <button
                  onClick={() => p.otcId && doCrank(p.otcId)}
                  disabled={!!busy}
                  className="ml-auto rounded-[6px] border px-2.5 py-1 font-mono text-[11px] font-semibold disabled:opacity-40"
                  style={{ borderColor: STATUS.red, color: STATUS.red }}
                >
                  {busy === p.otcId ? "…" : "Crank settlement →"}
                </button>
              ) : (
                <span className="ml-auto" />
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="break-words px-6 py-3 text-[12px]" style={{ color: STATUS.red }}>{error}</p>}
    </section>
  );
}

function HealthChip({ status, expired, health, now }: { status: number; expired: boolean; health?: ContractHealth; now: number }) {
  if (status === 1) return <Chip bg="rgba(0,0,0,0.07)" fg="var(--color-muted)">SETTLED</Chip>;
  if (status === 2) return <Chip bg="rgba(180,52,31,0.14)" fg={STATUS.red}>LIQUIDATED</Chip>;
  if (expired) return <Chip bg="rgba(0,0,0,0.07)" fg="var(--color-muted)">EXPIRED · settle via close</Chip>;
  if (health?.callDeadlineMs != null) {
    const left = health.callDeadlineMs - now;
    return (
      <Chip bg="rgba(180,52,31,0.14)" fg={STATUS.red}>
        ⚠ MARGIN CALL · {left > 0 ? `cure ${fmtMs(left)}` : "cure window over — liquidatable"}
      </Chip>
    );
  }
  if (health?.breached) return <Chip bg="rgba(180,52,31,0.10)" fg={STATUS.red}>MM BREACHED</Chip>;
  return <Chip bg="rgba(31,111,77,0.10)" fg={STATUS.green}>HEALTHY</Chip>;
}

function Chip({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span className="rounded-[5px] px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.04em]" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="text-right">
      <span className="block text-[10px] uppercase tracking-[0.1em] text-muted">{label}</span>
      <span className="font-semibold" style={{ color: color ?? "var(--color-ink)" }}>{value}</span>
    </span>
  );
}

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
