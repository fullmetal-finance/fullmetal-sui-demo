"use client";

import { usd } from "@/lib/fullmetal";
import { MOCK_TRADERS } from "@/lib/mock";

export default function TradersPanel() {
  return (
    <section className="rounded-[14px] border border-line-strong bg-surface">
      <div className="flex items-center justify-between border-b border-line-strong px-6 py-4">
        <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Traders &amp; limits</h2>
        <button className="rounded-[6px] border border-line-strong px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-bg">
          + Add trader
        </button>
      </div>
      <div className="divide-y divide-line">
        {MOCK_TRADERS.map((t) => {
          const util = t.book > 0 ? t.used / t.book : 0;
          return (
            <div key={t.address} className="flex items-center gap-4 px-6 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-semibold text-ink">{t.name}</p>
                <p className="font-mono text-[12px] text-muted">{t.address} · {t.role}</p>
              </div>
              <div className="w-[160px]">
                <div className="flex items-baseline justify-between font-mono text-[12px]">
                  <span className="text-muted">{usd(t.used, { maximumFractionDigits: 0 })}</span>
                  <span className="text-ink-soft">{usd(t.book, { maximumFractionDigits: 0 })}</span>
                </div>
                <div className="mt-1.5 h-[5px] overflow-hidden rounded-full bg-[rgba(0,0,0,0.07)]">
                  <div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, util * 100)}%` }} />
                </div>
              </div>
              <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                <span className="h-[6px] w-[6px] rounded-full bg-[#1f6f4d]" /> active
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
