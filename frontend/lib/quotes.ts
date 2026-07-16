"use client";

import { useCallback } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import { CLOCK, DBUSDC_TYPE, SHARED, TARGET } from "./fullmetal";
import { readFloor } from "./institution-state";
import { friendlyMoveError } from "./oracle";
import { useRehypothecate } from "./rehypo-actions";
import { useSponsoredExecute } from "./sponsored";
import { createdId, suiRead } from "./sui";
import { loadInstitution } from "./store";

export type QuoteInfo = {
  rfqId: string;
  makerInst: string;
  entryPrice: number;
  imEach: number;
  status: number; // 0 = live
  expiryMs: number;
};

/* ---- maker-desk quote delivery (chain-truth) ----
   The desks' quotes are shared objects on-chain; /api/makers GET recovers all
   LIVE ones for a set of RFQs, so delivery survives refreshes and lost
   responses. POST is idempotent "ensure quotes": desks that already quoted are
   skipped. */

export type DeskQuote = { org: string; quoteId: string; price: number; im: number; expiresMs: number };

export type RfqSection = {
  rfqId: string;
  status: number; // 0 open · 1 filled · 2 cancelled · -1 unreadable
  expiryMs: number;
  side: "long" | "short"; // the REQUESTER's side
  underlying: string;
  notional: number; // units of underlying
  imEach: number; // USD
  quotes: DeskQuote[];
};

/** All live on-chain quotes standing against these RFQs (+ each RFQ's state). */
export async function discoverQuotes(rfqIds: string[]): Promise<RfqSection[]> {
  if (!rfqIds.length) return [];
  const r = await fetch(`/api/makers?rfqIds=${rfqIds.join(",")}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `makers ${r.status}`);
  return (d as { sections: RfqSection[] }).sections;
}

/** Ask the desks to quote (idempotent). Throws the server's reason on failure —
 *  callers surface it; a silent preview state hid real outages before. */
export async function requestMakerQuotes(
  rfqId: string,
): Promise<{ quotes: DeskQuote[]; failed?: { org: string; error: string }[] }> {
  const r = await fetch("/api/makers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rfqId }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d as { error?: string }).error ?? `makers ${r.status}`);
  return d as { quotes: DeskQuote[]; failed?: { org: string; error: string }[] };
}

export async function readQuote(id: string): Promise<QuoteInfo> {
  const o = await suiRead.getObject({ id, options: { showContent: true } });
  const f = ((o.data?.content as { fields?: Record<string, string> } | undefined)?.fields ?? {});
  if (!f.rfq_id) throw new Error("That object is not an RFQ quote.");
  return {
    rfqId: f.rfq_id,
    makerInst: f.maker_inst,
    entryPrice: Number(f.entry_price) / 1e6,
    imEach: Number(f.im_each) / 1e6,
    status: Number(f.status),
    expiryMs: Number(f.quote_expiry_ms),
  };
}

/** RFQ lifecycle state: 0 open · 1 filled · 2 cancelled (+ its expiry). */
export async function readRfqState(id: string): Promise<{ status: number; expiryMs: number }> {
  const o = await suiRead.getObject({ id, options: { showContent: true } });
  const f = ((o.data?.content as { fields?: Record<string, string> } | undefined)?.fields ?? {});
  return { status: Number(f.status ?? "0"), expiryMs: Number(f.rfq_expiry_ms ?? "0") };
}

/** Requester-side acceptance of a firm quote → opens the bilateral OtcForward
 *  (reserves the requester leg, re-keys the maker's firm reservation). Gasless. */
export function useAcceptQuote() {
  const account = useCurrentAccount();
  const sponsoredExecute = useSponsoredExecute();
  const rehypothecate = useRehypothecate();

  return useCallback(
    async (quoteId: string): Promise<{ digest: string; otcId: string; deployWarning?: string }> => {
      if (!account) throw new Error("Sign in first.");
      const rec = loadInstitution(account.address);
      if (!rec) throw new Error("No institution.");
      if (!rec.traderCapId) throw new Error("No trader seat yet — open a contract first.");

      // pre-flight EVERYTHING the on-chain accept asserts, with human wording
      // (aborts 90/91/93/94 otherwise surface as raw dry-run failures)
      const q = await readQuote(quoteId);
      const rfq = await readRfqState(q.rfqId);
      if (rfq.status === 1) throw new Error("This RFQ is already filled — the winning quote opened a contract (see your blotter). The remaining quotes are void.");
      if (rfq.status === 2) throw new Error("This RFQ was cancelled — broadcast a new one.");
      if (rfq.expiryMs > 0 && Date.now() >= rfq.expiryMs) throw new Error("This RFQ has expired — broadcast a new one.");
      if (q.status !== 0) throw new Error("That quote is no longer live (withdrawn, already accepted, or reclaimed).");
      if (q.expiryMs > 0 && Date.now() >= q.expiryMs) throw new Error("That quote's TTL has passed — pick another quote or re-broadcast.");

      let digest: string;
      try {
        digest = await sponsoredExecute((tx) => {
          tx.moveCall({
            target: TARGET.rfq.acceptQuote,
            typeArguments: [DBUSDC_TYPE],
            arguments: [
              tx.object(q.rfqId),
              tx.object(quoteId),
              tx.object(rec.institutionId),
              tx.object(rec.traderCapId!),
              tx.object(q.makerInst),
              tx.object(SHARED.otcAllowlist),
              tx.object(CLOCK),
            ],
          });
        });
      } catch (e) {
        // races between pre-flight and execution still abort on-chain — translate
        throw new Error(friendlyMoveError(e instanceof Error ? e.message : String(e)));
      }
      await suiRead.waitForTransaction({ digest });
      const full = await suiRead.getTransactionBlock({
        digest,
        options: { showObjectChanges: true },
      });
      const otcId = createdId(full, "::otc_forward::OtcForward<");
      // default behaviour: the posted (locked) IM is rehypothecated to DeepBook
      // on open — ONLY the reserved margin, never free liquidity. Capped to the
      // on-chain deployable (floor) so the deploy cannot abort 23/24. Non-fatal
      // on failure, but SURFACED: a silent skip here reads as "deploy is broken".
      let deployWarning: string | undefined;
      if (q.imEach > 0) {
        try {
          const fl = await readFloor(rec.institutionId).catch(() => null);
          const amt = Math.floor(Math.min(q.imEach, fl?.deployable ?? q.imEach) * 100) / 100;
          if (amt > 0) await rehypothecate(amt);
          else deployWarning = "the on-chain liquidity floor leaves nothing deployable right now";
        } catch (e) {
          deployWarning = friendlyMoveError(e instanceof Error ? e.message : String(e));
          console.warn("[fullmetal] IM auto-deploy to DeepBook failed:", e);
        }
      }
      return { digest, otcId, deployWarning };
    },
    [account, sponsoredExecute, rehypothecate],
  );
}
