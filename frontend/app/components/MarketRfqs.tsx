"use client";

import { useState } from "react";

import { usd } from "@/lib/fullmetal";
import { MOCK_INCOMING_RFQS, type IncomingRfq } from "@/lib/mock";

/* The maker side of the book: RFQs other institutions have broadcast to this
   desk. Quoting is mocked for the demo (no on-chain quote is submitted). */
export default function MarketRfqs() {
  return (
    <section className="rounded-[14px] border border-line-strong bg-surface">
      <div className="flex items-center justify-between border-b border-line-strong px-6 py-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Incoming RFQs — Send quote</h2>
          <p className="mt-0.5 text-[12px] text-muted">Requests other institutions broadcast to your desk</p>
        </div>
        <span className="font-mono text-[12px] text-muted">{MOCK_INCOMING_RFQS.length} open</span>
      </div>
      <div className="divide-y divide-line">
        {MOCK_INCOMING_RFQS.map((r) => (
          <IncomingRow key={r.id} r={r} />
        ))}
      </div>
    </section>
  );
}

function IncomingRow({ r }: { r: IncomingRfq }) {
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState<number>(r.refPrice);
  const [sent, setSent] = useState(false);

  const sideCls =
    r.side === "buy"
      ? "bg-[#1f6f4d]/12 text-[#1a6042]"
      : r.side === "sell"
        ? "bg-[#b4341f]/12 text-[#9a2c1a]"
        : "bg-[rgba(0,0,0,0.06)] text-ink-soft";

  return (
    <div className="px-6 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-ink">{r.from}</span>
            <span className={`rounded-[5px] px-2 py-0.5 text-[11px] font-semibold uppercase ${sideCls}`}>{r.side}</span>
          </div>
          <p className="mt-0.5 font-mono text-[12px] text-muted">
            {r.asset} · {usd(r.notional, { maximumFractionDigits: 0 })} · {r.tenor} · {r.ageMins}m ago
          </p>
        </div>
        {sent ? (
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-[#1a6042]">
            ✓ Quoted {usd(price)} · awaiting acceptance
          </span>
        ) : (
          <button
            onClick={() => setOpen((o) => !o)}
            className="rounded-[6px] border border-line-strong px-3.5 py-1.5 text-[12px] font-semibold text-ink transition-colors hover:bg-bg"
          >
            {open ? "Cancel" : "Quote →"}
          </button>
        )}
      </div>

      {open && !sent && (
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted">Your price (USD)</span>
            <div className="flex items-center rounded-[7px] border border-line-strong bg-bg px-2.5">
              <span className="text-[14px] text-muted">$</span>
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(+e.target.value)}
                className="w-[130px] bg-transparent px-1 py-2 font-mono text-[14px] font-semibold text-ink outline-none"
              />
            </div>
          </label>
          <button
            onClick={() => {
              setSent(true);
              setOpen(false);
            }}
            className="rounded-[7px] border border-line-strong bg-ink px-4 py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90"
          >
            Send firm quote →
          </button>
          <span className="text-[11px] text-faint">Mock — no on-chain quote submitted in this demo</span>
        </div>
      )}
    </div>
  );
}
