"use client";

import { useCallback } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import { CLOCK, DBUSDC_TYPE, SHARED, TARGET } from "./fullmetal";
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

/** Requester-side acceptance of a firm quote → opens the bilateral OtcForward
 *  (reserves the requester leg, re-keys the maker's firm reservation). Gasless. */
export function useAcceptQuote() {
  const account = useCurrentAccount();
  const sponsoredExecute = useSponsoredExecute();
  const rehypothecate = useRehypothecate();

  return useCallback(
    async (quoteId: string): Promise<{ digest: string; otcId: string }> => {
      if (!account) throw new Error("Sign in first.");
      const rec = loadInstitution(account.address);
      if (!rec) throw new Error("No institution.");
      if (!rec.traderCapId) throw new Error("No trader seat yet — open a contract first.");

      const q = await readQuote(quoteId);
      if (q.status !== 0) throw new Error("Quote is no longer live.");

      const digest = await sponsoredExecute((tx) => {
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
      await suiRead.waitForTransaction({ digest });
      const full = await suiRead.getTransactionBlock({
        digest,
        options: { showObjectChanges: true },
      });
      const otcId = createdId(full, "::otc_forward::OtcForward<");
      // default behaviour: the posted IM is rehypothecated to DeepBook on open
      if (q.imEach > 0) {
        try {
          await rehypothecate(Math.floor(q.imEach * 100) / 100);
        } catch {
          /* non-fatal — deployable manually from the collateral engine */
        }
      }
      return { digest, otcId };
    },
    [account, sponsoredExecute, rehypothecate],
  );
}
