"use client";

import { useEffect, useState } from "react";

import { explorer, usd } from "@/lib/fullmetal";
import { useAcceptQuote } from "@/lib/quotes";
import { loadQuotes } from "@/lib/store";

type Quote = { org: string; quoteId?: string; price: number; im: number; ttl: string };

// Preview rows so the inbox reads as a live desk before the makers' firm quotes
// land. Real (acceptable) quotes are delivered off-chain into /quotes-<rfqId>.json
// by the maker service and replace these.
const PREVIEW: Quote[] = [
  { org: "Cumberland", price: 184.1, im: 5, ttl: "12:43" },
  { org: "Galaxy Digital", price: 185.0, im: 5, ttl: "11:50" },
  { org: "Wintermute", price: 185.4, im: 5, ttl: "09:12" },
];

export default function QuotesInbox({
  rfqIds,
  loading,
  onAccepted,
}: {
  rfqIds: string[];
  loading?: boolean;
  onAccepted?: (otcId: string) => void;
}) {
  const accept = useAcceptQuote();
  const [real, setReal] = useState<Quote[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!rfqIds.length) return;
    let alive = true;
    const read = () => {
      if (alive) setReal(rfqIds.flatMap((id) => loadQuotes(id)));
    };
    read();
    const t = setInterval(read, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [rfqIds]);

  const live = real.length > 0;
  const quotes = [...(live ? real : PREVIEW)].sort((a, b) => a.price - b.price); // requester long → lowest is best

  async function doAccept(q: Quote) {
    if (!q.quoteId) {
      setError("Preview quote — broadcast an RFQ and the desks' firm quotes will arrive here.");
      return;
    }
    setError(null);
    setBusy(q.quoteId);
    try {
      const r = await accept(q.quoteId);
      setDone(r.otcId);
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
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Incoming Quotes — Accept quotes</h2>
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-muted">
          <span className={`h-[6px] w-[6px] rounded-full ${loading ? "animate-pulse bg-[#1f6f4d]" : live ? "bg-[#1f6f4d]" : "bg-line-strong"}`} />
          {loading ? "desks responding…" : live ? "live · best price wins" : "preview · best price wins"}
        </span>
      </div>

      {done ? (
        <div className="px-6 py-6 text-[14px] text-ink">
          Contract opened —{" "}
          <a href={explorer.object(done)} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-muted underline hover:text-ink">
            {done.slice(0, 12)}… ↗
          </a>
        </div>
      ) : (
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr className="border-b border-line-strong text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
              <th className="px-6 py-2.5 font-medium">Counterparty</th>
              <th className="px-4 py-2.5 text-right font-medium">Price</th>
              <th className="px-4 py-2.5 text-right font-medium">IM each</th>
              <th className="px-4 py-2.5 text-right font-medium">Expires</th>
              <th className="px-6 py-2.5 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {quotes.map((q, i) => (
              <tr key={q.quoteId ?? q.org} className="border-b border-line text-ink last:border-b-0 odd:bg-bg/40">
                <td className="px-6 py-3.5">
                  <span className="font-semibold">{q.org}</span>
                  {i === 0 && <span className="ml-2 rounded-[4px] bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-bg">BEST</span>}
                </td>
                <td className="px-4 py-3.5 text-right font-mono font-semibold">{usd(q.price)}</td>
                <td className="px-4 py-3.5 text-right font-mono">{usd(q.im)}</td>
                <td className="px-4 py-3.5 text-right font-mono text-muted">{q.ttl}</td>
                <td className="px-6 py-3.5 text-right">
                  <button
                    onClick={() => doAccept(q)}
                    disabled={!!busy}
                    className={`rounded-[6px] px-3.5 py-1.5 text-[12px] font-semibold transition-opacity disabled:opacity-40 ${i === 0 ? "bg-ink text-bg hover:opacity-90" : "border border-line-strong text-ink hover:bg-bg"}`}
                  >
                    {busy === q.quoteId ? "Accepting…" : "Accept →"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <p className="break-words px-6 py-3 text-[12px] text-[#b4341f]">{error}</p>}
    </section>
  );
}
