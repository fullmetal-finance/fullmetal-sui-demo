"use client";

import { useState } from "react";

import { explorer, usd } from "@/lib/fullmetal";
import { readQuote, useAcceptQuote, type QuoteInfo } from "@/lib/quotes";

/** Paste a quote id (a maker's firm response to your RFQ), preview its terms,
 *  and accept → opens the bilateral OtcForward. Minimal incoming-quote inbox. */
export default function AcceptQuote({ onAccepted }: { onAccepted?: () => void }) {
  const accept = useAcceptQuote();
  const [id, setId] = useState("");
  const [info, setInfo] = useState<QuoteInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [otcId, setOtcId] = useState<string | null>(null);

  async function preview() {
    setError(null);
    setInfo(null);
    setOtcId(null);
    try {
      setInfo(await readQuote(id.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function doAccept() {
    setError(null);
    setBusy(true);
    try {
      const r = await accept(id.trim());
      setOtcId(r.otcId);
      onAccepted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 rounded-[16px] border-[0.5px] border-line bg-surface p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
        Incoming quotes
      </p>
      <p className="mt-2 text-[13px] leading-[1.7] text-ink-soft">
        Paste a maker&apos;s firm quote on one of your RFQs to accept it and open the contract.
      </p>

      <div className="mt-4 flex gap-2">
        <input
          value={id}
          onChange={(e) => setId(e.target.value)}
          onBlur={preview}
          placeholder="0x… quote id"
          className="w-full rounded-[7px] border-[0.5px] border-line bg-bg px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-line-strong"
        />
        <button
          onClick={doAccept}
          disabled={!id.trim() || busy || info?.status === 1}
          className="shrink-0 rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-2.5 text-[13px] text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "Accepting…" : "Accept →"}
        </button>
      </div>

      {info && !otcId && (
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
          <span>Price <span className="text-ink">{usd(info.entryPrice)}</span></span>
          <span>IM each <span className="text-ink">{usd(info.imEach)}</span></span>
          <span>{info.status === 0 ? "live" : "not live"}</span>
        </div>
      )}

      {otcId && (
        <p className="mt-3 text-[13px] text-ink">
          Contract opened —{" "}
          <a href={explorer.object(otcId)} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-muted underline hover:text-ink">
            {otcId.slice(0, 12)}… ↗
          </a>
        </p>
      )}

      {error && <p className="mt-3 break-words text-[12px] text-[#b4341f]">{error}</p>}
    </div>
  );
}
