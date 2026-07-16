"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { discoverQuotes, requestMakerQuotes, type RfqSection } from "./quotes";

/* Owns the whole RFQ→quotes lifecycle from the dashboard (always mounted, so
   the desks are engaged even while the user is on another tab):
   - a NEW open RFQ is auto-kicked once (POST ensure-quotes);
   - live quotes are re-discovered from the CHAIN every 4s (GET) — a refresh
     or a lost response can no longer orphan them;
   - kick failures are kept (with the server's reason) and retryable. */

export type MakerQuotesState = {
  /** open RFQs (newest first) with their live on-chain quotes */
  sections: RfqSection[];
  /** a quote request is in flight */
  pending: boolean;
  /** last quote-request failure — shown verbatim, retryable */
  error: string | null;
  /** desks that individually failed on the last request */
  failed: { org: string; error: string }[];
  /** re-request quotes for the newest open RFQ */
  retry: () => void;
};

const POLL_MS = 4_000;
const WATCH_LAST = 4; // stored rfqIds accumulate; only the newest few can be open

export function useMakerQuotes(rfqIds: string[]): MakerQuotesState {
  const [sections, setSections] = useState<RfqSection[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ org: string; error: string }[]>([]);
  const kicked = useRef<Set<string>>(new Set());
  const inFlight = useRef(false);

  const watchKey = rfqIds.slice(-WATCH_LAST).join(",");

  const kick = useCallback(async (rfqId: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    kicked.current.add(rfqId);
    setPending(true);
    setError(null);
    setFailed([]);
    try {
      const r = await requestMakerQuotes(rfqId);
      setFailed(r.failed ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }, []);

  // chain discovery loop
  useEffect(() => {
    const ids = watchKey ? watchKey.split(",") : [];
    if (!ids.length) {
      setSections([]);
      return;
    }
    let alive = true;
    const read = async () => {
      try {
        const all = await discoverQuotes(ids);
        if (!alive) return;
        const open = all
          .filter((s) => s.status === 0 && Date.now() < s.expiryMs)
          .reverse(); // stored oldest→newest; show newest first
        setSections(open);
        // auto-kick exactly once per open RFQ that has no quotes yet
        const bare = open.find((s) => !s.quotes.length && !kicked.current.has(s.rfqId));
        if (bare) void kick(bare.rfqId);
      } catch {
        /* transient RPC wobble — keep the last good state */
      }
    };
    read();
    const t = setInterval(read, POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [watchKey, kick]);

  const retry = useCallback(() => {
    const newest = sections[0];
    if (newest) void kick(newest.rfqId);
  }, [sections, kick]);

  return { sections, pending, error, failed, retry };
}
