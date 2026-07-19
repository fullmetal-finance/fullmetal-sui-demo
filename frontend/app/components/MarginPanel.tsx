"use client";

import { useCallback, useEffect, useState } from "react";

import { usd } from "@/lib/fullmetal";
import type { InstState } from "@/lib/institution-state";
import { readContractsHealth, type ContractHealth } from "@/lib/institution-state";
import { positionPnl, type MockPosition } from "@/lib/mock";
import { crankContract } from "@/lib/oracle";
import { CATEGORICAL, STATUS } from "@/lib/palette";

/* Cross-margin panel — makes the mechanism VISIBLE, not just named:
   1. one pooled-treasury bar: every trade's IM is a colored fence INSIDE the
      same bar (an accounting hold — the coins never move), the rest is ONE
      shared VM buffer, and the red rule is the Σ-maintenance floor;
   2. a live VM-netting readout: each position's mark-to-market flow, and the
      single NET figure the pool actually settles — gains on one contract
      backing losses on another is what cross-margin IS;
   3. a buffer-coverage gauge (free ÷ Σ maintenance) — desk health in one number;
   4. per-contract rows with live health, margin-call countdowns and the
      permissionless crank. */

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
  const fenced = open.filter((p) => !isExpired(p)); // expired stay listed below, not fenced (IM reserved until closed)

  // live VM per open position, and what the POOL actually settles (the net)
  const flows = fenced.map((p) => ({ p, vm: positionPnl(p) }));
  const grossVm = flows.reduce((s, f) => s + Math.abs(f.vm), 0);
  const netVm = flows.reduce((s, f) => s + f.vm, 0);
  const coverage = maintenance > 0 ? free / maintenance : null;

  const pct = (v: number) => (equity > 0 ? Math.min(100, (v / equity) * 100) : 0);
  const color = (i: number) => CATEGORICAL[i % CATEGORICAL.length];

  return (
    <section className="rounded-[14px] border border-line-strong bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-line-strong px-6 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Cross-margin — one pool backs every trade</h2>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 font-mono text-[12px]">
          <Stat label="Pool equity" value={usd(equity)} />
          <Stat label="Locked IM" value={usd(reserved)} color="#2456c4" />
          <Stat label="Σ maintenance" value={usd(maintenance)} color={STATUS.red} />
          <Stat label="Shared buffer" value={usd(free)} color={STATUS.green} />
          <CoverageChip coverage={coverage} />
        </div>
      </div>

      {/* the pooled-treasury bar */}
      <div className="px-6 pb-1 pt-5">
        <div className="relative pb-12 pt-4">
          {maintenance > 0 && (
            <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2" style={{ left: `${pct(maintenance)}%` }}>
              <span className="whitespace-nowrap rounded-[4px] px-1.5 py-0.5 font-mono text-[9.5px] font-bold text-white" style={{ background: STATUS.red }}>
                Σ-maintenance floor {usd(maintenance)} — the pool must never run below this
              </span>
            </div>
          )}
          <div className="flex h-[34px] w-full overflow-hidden rounded-[8px]" style={{ background: "rgba(31,111,77,0.14)" }}>
            {fenced.map((p, i) => {
              const w = pct(p.im);
              return (
                <div
                  key={p.otcId}
                  title={`${p.asset} ${p.side.toUpperCase()} vs ${p.cpty} — IM ${usd(p.im)} locked (no separate account)`}
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
            <div className="flex h-full flex-1 items-center justify-center" title={`Shared VM buffer ${usd(free)} — every position's variation margin settles from this same capital; it stays liquid in the treasury (only the locked IM is rehypothecated)`}>
              {pct(free) > 14 && (
                <span className="font-mono text-[10px] font-semibold" style={{ color: "#1a6042" }}>
                  shared buffer {usd(free, { maximumFractionDigits: 0 })} · pays every position&apos;s VM · stays liquid
                </span>
              )}
            </div>
          </div>
          {maintenance > 0 && (
            <div className="pointer-events-none absolute bottom-12 top-4" style={{ left: `${pct(maintenance)}%` }}>
              <div className="h-full w-[2.5px]" style={{ background: STATUS.red }} />
            </div>
          )}
          {/* bracket captions: fences vs shared buffer */}
          <div className="absolute bottom-5 left-0 flex w-full font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            {reserved > 0 && (
              <span className="flex flex-col" style={{ width: `${pct(reserved)}%`, minWidth: 120 }}>
                <span className="border-x border-b border-line-strong" style={{ height: 5 }} />
                <span className="mt-1">locked IM — one hold per trade</span>
              </span>
            )}
            <span className="flex flex-1 flex-col pl-2" style={{ minWidth: 140 }}>
              <span className="border-x border-b border-line-strong" style={{ height: 5 }} />
              <span className="mt-1" style={{ color: "#1a6042" }}>one shared VM buffer — not split per trade</span>
            </span>
          </div>
          <div className="absolute bottom-0 left-0 flex w-full justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-muted">
            <span>■ colors match the position rows below</span>
            <span>whole bar = pool equity {usd(equity)}</span>
          </div>
        </div>
      </div>

      {/* the cross-margin EFFECT: VM nets at the pool */}
      {flows.length > 0 && (
        <div className="mx-6 mb-4 rounded-[10px] border border-line bg-bg/60 px-4 py-3">
          <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">
            VM netting — why cross-margin matters
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-2 text-[12.5px]">
            {flows.map((f, i) => (
              <span key={f.p.otcId} className="flex items-center gap-1.5">
                {i > 0 && <span className="font-mono text-muted">+</span>}
                <span className="flex items-center gap-1.5 rounded-[6px] border border-line px-2 py-1 font-mono text-[12px]">
                  <span className="h-[9px] w-[9px] rounded-[2.5px]" style={{ background: color(fenced.indexOf(f.p)) }} />
                  <span className="text-ink">{f.p.asset} {f.p.side === "long" ? "L" : "S"}</span>
                  <span className="font-semibold" style={{ color: f.vm >= 0 ? "#1a6042" : "#9a2c1a" }}>
                    {f.vm >= 0 ? "+" : "−"}{usd(Math.abs(f.vm))}
                  </span>
                </span>
              </span>
            ))}
            <span className="font-mono text-[13px] text-muted">→</span>
            <span className="rounded-[6px] px-2.5 py-1 font-mono text-[12px] font-bold text-white" style={{ background: netVm >= 0 ? "#1f6f4d" : "#b4341f" }}>
              pool settles NET {netVm >= 0 ? "+" : "−"}{usd(Math.abs(netVm))}
            </span>
          </div>
          <p className="mt-2 text-[11.5px] leading-[1.6] text-muted">
            {flows.length > 1 ? (
              <>
                Siloed per-trade accounts would each move their own full leg — {usd(grossVm)} of gross collateral
                traffic{grossVm - Math.abs(netVm) > 0.005 && (
                  <>
                    , of which <b className="text-ink">{usd(grossVm - Math.abs(netVm))} never needs to move here</b> because
                    opposing positions offset inside the pool
                  </>
                )}. One buffer, one net settlement.
              </>
            ) : (
              <>
                This flow settles against the <b>shared buffer</b> — there is no per-trade account it could be trapped
                in. Open an opposing position and the two VM legs net <i>before</i> touching the buffer: that offset is
                the cross-margin saving.
              </>
            )}
          </p>
        </div>
      )}

      {/* per-contract health rows */}
      <div className="divide-y divide-line border-t border-line">
        {real.length === 0 && (
          <p className="px-6 py-4 text-[13px] text-muted">No open contracts yet — accept an RFQ quote or propose a direct trade, and its locked IM appears inside the pool above.</p>
        )}
        {real.map((p) => {
          const h = p.otcId ? health[p.otcId] : undefined;
          const status = liveStatus(p);
          const expired = isExpired(p);
          const fi = fenced.findIndex((f) => f.otcId === p.otcId);
          const vm = status === 0 && !expired ? positionPnl(p) : 0;
          const crankableNow = status === 0 && !expired && (h?.breached || h?.callDeadlineMs != null);
          return (
            <div key={p.otcId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3 text-[13px]">
              <span className="h-[12px] w-[12px] shrink-0 rounded-[3px]" style={{ background: fi >= 0 ? color(fi) : "var(--color-line-strong)" }} />
              <div className="flex min-w-[190px] items-center gap-2.5">
                <span className="font-semibold text-ink">{p.asset}</span>
                <span
                  className="rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold"
                  style={p.side === "long" ? { background: "rgba(31,111,77,0.12)", color: "#1a6042" } : { background: "rgba(180,52,31,0.12)", color: "#9a2c1a" }}
                >
                  {p.side.toUpperCase()}
                </span>
                <span className="text-muted">vs {p.cpty}</span>
              </div>
              <span className="font-mono text-[12px] text-muted">
                {usd(p.entry)} → <span className="text-ink">{usd(p.mark)}</span>
              </span>
              <span className="font-mono text-[12px] text-muted">
                IM <span className="text-ink">{usd(p.im)}</span>
              </span>
              <span className="font-mono text-[12px] text-muted">
                maint <span className="text-ink">{usd(p.im * 0.7)}</span>
              </span>
              {status === 0 && !expired && (
                <span className="font-mono text-[12px] font-semibold" style={{ color: vm >= 0 ? "#1a6042" : "#9a2c1a" }}>
                  VM {vm >= 0 ? "+" : "−"}{usd(Math.abs(vm))}
                </span>
              )}
              <HealthChip status={status} expired={expired} health={h} now={now} side={p.side} cpty={p.cpty} />
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

      <p className="border-t border-line px-6 py-2.5 font-mono text-[10.5px] leading-[1.7] text-faint">
        locked ≠ transferred (the pool stays whole — the locked IM is what rehypothecates to venues) · one Σ-maintenance
        rule on the pool, not per trade · a breach is due process: margin call → cure window → only then liquidation,
        crankable by anyone.
      </p>

      {error && <p className="break-words px-6 py-3 text-[12px]" style={{ color: STATUS.red }}>{error}</p>}
    </section>
  );
}

function CoverageChip({ coverage }: { coverage: number | null }) {
  if (coverage == null) {
    return (
      <span className="rounded-[5px] px-2 py-1 font-mono text-[10.5px] font-semibold" style={{ background: "rgba(31,111,77,0.10)", color: "#1a6042" }}>
        NO MAINTENANCE LOAD
      </span>
    );
  }
  const tone =
    coverage >= 1.5
      ? { background: "rgba(31,111,77,0.10)", color: "#1a6042", word: "SAFE" }
      : coverage >= 1
        ? { background: "rgba(138,109,26,0.12)", color: "#8a6d1a", word: "TIGHT" }
        : { background: "rgba(180,52,31,0.14)", color: STATUS.red, word: "UNDER FLOOR" };
  return (
    <span className="rounded-[5px] px-2 py-1 font-mono text-[10.5px] font-semibold" style={{ background: tone.background, color: tone.color }} title="shared buffer ÷ Σ maintenance — the one number for desk health">
      BUFFER {coverage >= 100 ? ">99" : coverage.toFixed(1)}× Σ-MAINT · {tone.word}
    </span>
  );
}

function HealthChip({
  status,
  expired,
  health,
  now,
  side,
  cpty,
}: {
  status: number;
  expired: boolean;
  health?: ContractHealth;
  now: number;
  side: "long" | "short";
  cpty: string;
}) {
  if (status === 1) return <Chip bg="rgba(0,0,0,0.07)" fg="var(--color-muted)">SETTLED</Chip>;
  if (status === 2) return <Chip bg="rgba(180,52,31,0.14)" fg={STATUS.red}>LIQUIDATED</Chip>;
  if (expired) return <Chip bg="rgba(0,0,0,0.07)" fg="var(--color-muted)">EXPIRED · settle via close</Chip>;
  if (health?.callDeadlineMs != null) {
    const left = health.callDeadlineMs - now;
    // the on-chain call names its debtor: a call is due process for ONE side —
    // a long whose mark went UP is looking at the COUNTERPARTY's call
    const mineOwes = health.callShortOwes == null ? true : (side === "short") === health.callShortOwes;
    const clock = left > 0 ? `cure ${fmtMs(left)}` : "cure over — liquidatable";
    return mineOwes ? (
      <Chip bg="rgba(180,52,31,0.14)" fg={STATUS.red}>⚠ MARGIN CALL — you owe VM · {clock}</Chip>
    ) : (
      <Chip bg="rgba(138,109,26,0.12)" fg="#8a6d1a">⚠ {cpty} margin-called — they owe you · {clock}</Chip>
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
