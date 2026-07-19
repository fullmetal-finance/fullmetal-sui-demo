"use client";

import { useEffect, useState } from "react";

import { explorer, usd } from "@/lib/fullmetal";
import { useAcceptQuote, type DeskQuote, type RfqSection } from "@/lib/quotes";
import type { MakerQuotesState } from "@/lib/use-maker-quotes";

/* Incoming-quotes inbox. Rows are LIVE on-chain quote objects discovered from
   the chain every few seconds (see useMakerQuotes) — never a cached copy, so
   they survive refreshes and appear in any browser. Before the desk has ever
   broadcast an RFQ, a clearly-labelled SAMPLE table shows what arrives. */

const SAMPLE = [
  { org: "Cumberland", price: 148.18, im: 8 },
  { org: "Galaxy Digital", price: 148.37, im: 8 },
  { org: "Wintermute", price: 148.59, im: 8 },
];
const DESKS = ["Cumberland", "Galaxy Digital", "Wintermute"];

export default function QuotesInbox({
  rfqIds,
  quotes,
  onAccepted,
}: {
  rfqIds: string[];
  quotes: MakerQuotesState;
  onAccepted?: (otcId: string) => void;
}) {
  const accept = useAcceptQuote();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const { sections, pending, error: deskError, failed, retry } = quotes;
  const live = sections.some((s) => s.quotes.length > 0);

  async function doAccept(q: DeskQuote) {
    setError(null);
    setBusy(q.quoteId);
    try {
      const r = await accept(q.quoteId);
      setDone(r.otcId);
      if (r.deployWarning) {
        setError(`Contract opened — but the locked IM did not auto-deploy to DeepBook (${r.deployWarning}). Deploy it from the collateral manager.`);
      }
      onAccepted?.(r.otcId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-[14px] border border-line-strong bg-surface">
      <div className="flex items-center justify-between border-b border-line-strong px-6 py-4">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Incoming quotes</h2>
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-muted">
          <span className={`h-[6px] w-[6px] rounded-full ${pending ? "animate-pulse bg-[#1f6f4d]" : live ? "bg-[#1f6f4d]" : "bg-line-strong"}`} />
          {pending ? "desks pricing…" : live ? "live on-chain quotes" : rfqIds.length ? "no live quotes" : "sample"}
        </span>
      </div>

      {done ? (
        <div className="px-6 py-6 text-[14px] text-ink">
          Contract opened —{" "}
          <a href={explorer.object(done)} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-muted underline hover:text-ink">
            {done.slice(0, 12)}… ↗
          </a>
        </div>
      ) : sections.length === 0 ? (
        rfqIds.length === 0 ? (
          <>
            <p className="px-6 pt-4 text-[12.5px] leading-[1.6] text-muted">
              Broadcast an RFQ (<b>New OTC contract → Broadcast</b>) and the desks answer with firm, collateral-backed
              quotes — each one a live on-chain object with the maker&apos;s margin already locked behind it. A sample of
              what arrives:
            </p>
            <QuoteTable
              quotes={SAMPLE.map((s) => ({ ...s, quoteId: "", expiresMs: 0 }))}
              side="long"
              now={now}
              sample
            />
          </>
        ) : (
          <div className="px-6 py-5 text-[13px] leading-[1.6] text-muted">
            No open RFQs right now — your last one was filled or expired.
            <span className="text-ink"> Broadcast a new RFQ</span> from <b>New OTC contract</b> and the desks&apos; firm
            quotes appear here within seconds.
          </div>
        )
      ) : (
        sections.map((s) => (
          <RfqBlock
            key={s.rfqId}
            section={s}
            now={now}
            pending={pending}
            deskError={deskError}
            onRetry={retry}
            busy={busy}
            onAccept={doAccept}
          />
        ))
      )}

      {failed.length > 0 && !deskError && (
        <p className="border-t border-line px-6 py-2.5 text-[11.5px] text-[#8a6d1a]">
          {failed.map((f) => `${f.org} could not quote (${f.error})`).join(" · ")}
        </p>
      )}
      {error && <p className="break-words border-t border-line px-6 py-3 text-[12px] text-[#b4341f]">{error}</p>}
    </section>
  );
}

/* One open RFQ: header (what you asked for + its clock) + its quotes/state. */
function RfqBlock({
  section: s,
  now,
  pending,
  deskError,
  onRetry,
  busy,
  onAccept,
}: {
  section: RfqSection;
  now: number;
  pending: boolean;
  deskError: string | null;
  onRetry: () => void;
  busy: string | null;
  onAccept: (q: DeskQuote) => void;
}) {
  const bestPrice = s.quotes.length
    ? s.side === "long"
      ? Math.min(...s.quotes.map((q) => q.price))
      : Math.max(...s.quotes.map((q) => q.price))
    : 0;
  return (
    <div className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-bg/50 px-6 py-2.5 font-mono text-[11.5px] text-muted">
        <span className="font-semibold text-ink">{s.underlying}</span>
        <span>{s.notional} unit{s.notional === 1 ? "" : "s"}</span>
        {bestPrice > 0 && (
          <span className="text-ink">≈ {usd(s.notional * bestPrice, { maximumFractionDigits: 0 })} notional</span>
        )}
        <span
          className="rounded-[4px] px-1.5 py-0.5 text-[10px] font-semibold"
          style={s.side === "long" ? { background: "rgba(31,111,77,0.12)", color: "#1a6042" } : { background: "rgba(180,52,31,0.12)", color: "#9a2c1a" }}
        >
          you {s.side.toUpperCase()}
        </span>
        <span>IM {usd(s.imEach)} each</span>
        <span className="ml-auto">
          {s.side === "long" ? "lowest ask wins" : "highest bid wins"} · RFQ expires {fmtLeft(s.expiryMs - now)}
        </span>
      </div>

      {s.quotes.length > 0 ? (
        <QuoteTable quotes={s.quotes} side={s.side} now={now} busy={busy} onAccept={onAccept} />
      ) : deskError ? (
        <div className="px-6 py-4">
          <p className="break-words text-[12.5px] leading-[1.6] text-[#b4341f]">
            The desks could not quote: {deskError}
          </p>
          <button
            onClick={onRetry}
            disabled={pending}
            className="mt-2.5 rounded-[6px] border border-line-strong px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-bg disabled:opacity-40"
          >
            {pending ? "Retrying…" : "↻ Retry quote request"}
          </button>
        </div>
      ) : pending ? (
        <div className="divide-y divide-line">
          {DESKS.map((org) => (
            <div key={org} className="flex items-center gap-3 px-6 py-3.5 text-[13px]">
              <span className="font-semibold text-ink">{org}</span>
              <span className="fm-pulse font-mono text-[12px] text-muted">pricing off the live mark…</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 px-6 py-4 text-[13px] text-muted">
          No live quotes on this RFQ (they expire with their TTL).
          <button
            onClick={onRetry}
            className="rounded-[6px] border border-line-strong px-3 py-1.5 text-[12px] font-semibold text-ink hover:bg-bg"
          >
            Request quotes
          </button>
        </div>
      )}
    </div>
  );
}

function QuoteTable({
  quotes,
  side,
  now,
  busy,
  onAccept,
  sample,
}: {
  quotes: DeskQuote[];
  side: "long" | "short";
  now: number;
  busy?: string | null;
  onAccept?: (q: DeskQuote) => void;
  sample?: boolean;
}) {
  // requester long buys at the makers' ASK → lowest wins; short sells → highest
  const sorted = [...quotes].sort((a, b) => (side === "long" ? a.price - b.price : b.price - a.price));
  return (
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr className="border-b border-line text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
          <th className="px-6 py-2.5 font-medium">Counterparty</th>
          <th className="px-4 py-2.5 text-right font-medium">{side === "long" ? "Ask" : "Bid"}</th>
          <th className="px-4 py-2.5 text-right font-medium">IM each</th>
          <th className="px-4 py-2.5 text-right font-medium">Quote TTL</th>
          <th className="px-6 py-2.5 text-right font-medium"></th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((q, i) => (
          <tr key={q.quoteId || q.org} className="border-b border-line text-ink last:border-b-0 odd:bg-bg/40">
            <td className="px-6 py-3.5">
              <span className="font-semibold">{q.org}</span>
              {i === 0 && <span className="ml-2 rounded-[4px] bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-bg">BEST</span>}
              {sample && <span className="ml-2 rounded-[4px] border border-line-strong px-1.5 py-0.5 text-[10px] font-semibold text-muted">SAMPLE</span>}
            </td>
            <td className="px-4 py-3.5 text-right font-mono font-semibold">{usd(q.price)}</td>
            <td className="px-4 py-3.5 text-right font-mono">{usd(q.im)}</td>
            <td className="px-4 py-3.5 text-right font-mono text-muted">{sample ? "—" : fmtLeft(q.expiresMs - now)}</td>
            <td className="px-6 py-3.5 text-right">
              {sample ? (
                <span className="font-mono text-[11px] text-faint">broadcast to go live</span>
              ) : (
                <button
                  onClick={() => onAccept?.(q)}
                  disabled={!!busy || q.expiresMs <= now}
                  className={`rounded-[6px] px-3.5 py-1.5 text-[12px] font-semibold transition-opacity disabled:opacity-40 ${i === 0 ? "bg-ink text-bg hover:opacity-90" : "border border-line-strong text-ink hover:bg-bg"}`}
                >
                  {busy === q.quoteId ? "Accepting…" : q.expiresMs <= now ? "Expired" : "Accept →"}
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, "0")}`;
}
