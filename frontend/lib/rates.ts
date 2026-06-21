"use client";

import { useEffect, useState } from "react";

export type VenueKey = "deepbook" | "suilend" | "navi";

export type RatesResponse = {
  rates: Record<VenueKey, number>; // supply APR, percent
  live: Record<VenueKey, boolean>; // true = fetched live, false = indicative
  fetchedAt: number;
};

/** Display metadata for the three rehypothecation venues, in venue order. */
export const VENUES: { key: VenueKey; name: string; logo: string }[] = [
  { key: "deepbook", name: "DeepBook", logo: "/logos/deepbook.png" },
  { key: "suilend", name: "Suilend", logo: "/logos/suilend.png" },
  { key: "navi", name: "Navi", logo: "/logos/navi.png" },
];

/** Poll the live USDC supply-APR feed (Navi live; others indicative). */
export function useRates(): RatesResponse | null {
  const [data, setData] = useState<RatesResponse | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/rates")
        .then((r) => r.json())
        .then((d) => alive && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, 120_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return data;
}
