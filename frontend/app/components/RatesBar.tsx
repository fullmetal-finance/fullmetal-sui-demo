"use client";

import Image from "next/image";

import { useRates, VENUES } from "@/lib/rates";

/* Live USDC supply yield across the rehypothecation venues — shown above the
   dashboard tabs so the desk can see where idle margin earns most. */
export default function RatesBar() {
  const data = useRates();
  return (
    <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[12px] border border-line bg-surface px-5 py-3.5">
      <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
        USDC supply yield
      </span>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5">
        {VENUES.map((v) => (
          <span key={v.key} className="flex items-center gap-2">
            <Image src={v.logo} alt={v.name} width={20} height={20} className="rounded-[5px]" />
            <span className="text-[13px] font-medium text-ink">{v.name}</span>
            <span className="font-mono text-[13px] font-semibold text-[#1a6042]">
              {data ? `${data.rates[v.key].toFixed(2)}%` : "—"}
            </span>
          </span>
        ))}
      </div>
      <span className="ml-auto flex items-center gap-1.5 font-mono text-[11px] text-muted">
        <span className="h-[5px] w-[5px] rounded-full bg-[#1f6f4d]" /> live · APR
      </span>
    </div>
  );
}
