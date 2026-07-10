"use client";

import { useCallback, useEffect, useState } from "react";

import { usd } from "@/lib/fullmetal";
import type { InstState } from "@/lib/institution-state";
import { readContractsHealth, type ContractHealth } from "@/lib/institution-state";
import type { MockPosition } from "@/lib/mock";
import { crankContract } from "@/lib/oracle";

/* Cross-margin panel: ONE pooled treasury, per-contract IM fences inside it.
   Funds never move into per-position silos — `reserved` is an accounting
   overlay, so the same pool backs every contract AND keeps earning at venues.
   The bar shows equity with each open contract's IM as a fenced segment
   (2px surface gaps); the red rule is Σ maintenance — the level the pool must
   never be run below. Rows carry live health: a breach shows the margin-call
   countdown (cure window) and the permissionless crank. */

const RED = "#b4341f";
const GREEN = "#1f6f4d";

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
  const headroom = Math.max(0, equity - maintenance);
  const open = real.filter((p) => (p.status ?? 0) === 0 && (health[p.otcId!]?.status ?? p.status ?? 0) === 0);

  const pct = (v: number) => (equity > 0 ? Math.min(100, (v / equity) * 100) : 0);

  return (
    <section className="rounded-[14px] border border-line-strong bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-strong px-6 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Cross-margin — one pooled treasury</h2>
          <p className="mt-0.5 text-[12px] text-muted">
            IM is fenced inside the pool, never siloed per position — and the fenced collateral is simultaneously earning at venues.
          </p>
        </div>
        <div className="flex gap-6 font-mono text-[12px]">
          <Stat label="Equity" value={usd(equity)} />
          <Stat label="Σ reserved IM" value={usd(reserved)} />
          <Stat label="Σ maintenance" value={usd(maintenance)} tone="red" />
          <Stat label="Headroom" value={usd(headroom)} tone="green" />
        </div>
      </div>

      {/* the pooled-treasury bar: IM fences + free headroom + maintenance rule */}
      <div className="px-6 pt-5">
        <div className="relative">
          <div className="flex h-[26px] w-full overflow-hidden rounded-[6px] bg-[rgba(0,0,0,0.05)]">
            {open.map((p, i) => (
              <div
                key={p.otcId}
                title={`${p.asset} ${p.side.toUpperCase()} vs ${p.cpty} — IM ${usd(p.im)}`}
                className="h-full border-r-2 border-surface transition-[width] duration-500"
                style={{
                  width: `${pct(p.im)}%`,
                  background: `rgba(15,15,15,${0.78 - (i % 3) * 0.22})`,
                }}
              />
            ))}
            <div className="h-full flex-1" title={`Free headroom ${usd(Math.max(0, equity - reserved))}`} />
          </div>
          {/* Σ maintenance rule */}
          {maintenance > 0 && (
            <div className="pointer-events-none absolute -top-1 bottom-[-4px]" style={{ left: `${pct(maintenance)}%` }}>
              <div className="h-full w-[2px]" style={{ background: RED }} />
            </div>
          )}
        </div>
        <div className="mt-1.5 flex justify-between font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">
          <span>■ fenced IM per contract · light = free, deployable</span>
          {maintenance > 0 && <span style={{ color: RED }}>| Σ maintenance {usd(maintenance)}</span>}
        </div>
      </div>

      {/* per-contract health rows */}
      <div className="mt-4 divide-y divide-line border-t border-line">
        {open.length === 0 && (
          <p className="px-6 py-4 text-[13px] text-muted">No open contracts yet — accept an RFQ quote or propose a direct trade.</p>
        )}
        {real.map((p) => {
          const h = p.otcId ? health[p.otcId] : undefined;
          const status = h?.status ?? p.status ?? 0;
          return (
            <div key={p.otcId} className="flex flex-wrap items-center justify-between gap-2 px-6 py-3 text-[13px]">
              <div className="flex min-w-[220px] items-center gap-2.5">
                <span className="font-semibold text-ink">{p.asset}</span>
                <span className={`rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-semibold ${p.side === "long" ? "bg-[#1f6f4d]/12 text-[#1a6042]" : "bg-[#b4341f]/12 text-[#9a2c1a]"}`}>
                  {p.side.toUpperCase()}
                </span>
                <span className="text-muted">vs {p.cpty}</span>
              </div>
              <span className="font-mono text-muted">IM {usd(p.im)}</span>
              <span className="font-mono text-muted">maint {usd(p.im * 0.7)}</span>
              <HealthChip status={status} health={h} now={now} />
              {status === 0 && (h?.breached || h?.callDeadlineMs != null) ? (
                <button
                  onClick={() => p.otcId && doCrank(p.otcId)}
                  disabled={!!busy}
                  className="rounded-[6px] border px-2.5 py-1 font-mono text-[11px] font-semibold disabled:opacity-40"
                  style={{ borderColor: RED, color: RED }}
                >
                  {busy === p.otcId ? "…" : "Crank settlement →"}
                </button>
              ) : (
                <span className="w-[130px]" />
              )}
            </div>
          );
        })}
      </div>

      {error && <p className="break-words px-6 py-3 text-[12px]" style={{ color: RED }}>{error}</p>}
    </section>
  );
}

function HealthChip({ status, health, now }: { status: number; health?: ContractHealth; now: number }) {
  if (status === 1) return <Chip bg="rgba(0,0,0,0.07)" fg="var(--color-muted)">SETTLED</Chip>;
  if (status === 2) return <Chip bg="rgba(180,52,31,0.14)" fg={RED}>LIQUIDATED</Chip>;
  if (health?.callDeadlineMs != null) {
    const left = health.callDeadlineMs - now;
    return (
      <Chip bg="rgba(180,52,31,0.14)" fg={RED}>
        ⚠ MARGIN CALL · {left > 0 ? `cure ${fmtMs(left)}` : "cure window over — liquidatable"}
      </Chip>
    );
  }
  if (health?.breached) return <Chip bg="rgba(180,52,31,0.10)" fg={RED}>MM BREACHED</Chip>;
  return <Chip bg="rgba(31,111,77,0.10)" fg={GREEN}>HEALTHY</Chip>;
}

function Chip({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return (
    <span className="rounded-[5px] px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.04em]" style={{ background: bg, color: fg }}>
      {children}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "red" | "green" }) {
  return (
    <span className="text-right">
      <span className="block text-[10px] uppercase tracking-[0.1em] text-muted">{label}</span>
      <span className="font-semibold" style={{ color: tone === "red" ? RED : tone === "green" ? GREEN : "var(--color-ink)" }}>
        {value}
      </span>
    </span>
  );
}

function fmtMs(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
