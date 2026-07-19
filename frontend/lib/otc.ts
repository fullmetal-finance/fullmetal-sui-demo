"use client";

import { useCallback } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, SHARED, TARGET, toUnits } from "./fullmetal";
import { readFloor } from "./institution-state";
import { friendlyMoveError } from "./oracle";
import { useRehypothecate } from "./rehypo-actions";
import { useSponsoredExecute } from "./sponsored";
import { createdId, suiRead } from "./sui";
import { loadInstitution, saveInstitution } from "./store";

const DEFAULT_BOOK_SIZE = 1_000_000_000_000n; // 1,000,000 DBUSDC trading limit

export type OtcDraft = {
  entry: "direct" | "rfq";
  counterparty: string; // org handle or 0x institution id (direct only)
  side: "long" | "short";
  asset: string;
  notional: number; // units of underlying
  strike: number; // USD per unit (direct only; RFQ leaves price to the maker)
  im: number; // initial margin each side (USD)
  settlementMs: number;
  contractExpiryMs: number; // absolute ms (0 = perpetual)
  offerTtlMs: number;
  rehypo: boolean; // deploy the posted IM to DeepBook on open
};

export type OtcResult = {
  digest: string;
  offerId: string;
  kind: "direct" | "rfq";
  /** the contract opened but the IM auto-deploy to DeepBook failed — deploy
   *  manually from the collateral manager (only locked IM is rehypothecated) */
  deployWarning?: string;
};

/** Encapsulates everything the create-OTC pop-up needs: ensure the signed-in
 *  admin has a trader seat (lazy self-grant), resolve the counterparty by org
 *  handle, and propose the contract — all gasless. */
export function useCreateOtc() {
  const account = useCurrentAccount();
  const sponsoredExecute = useSponsoredExecute();
  const rehypothecate = useRehypothecate();

  return useCallback(
    async (d: OtcDraft): Promise<OtcResult> => {
      if (!account) throw new Error("Sign in first.");
      const rec = loadInstitution(account.address);
      if (!rec) throw new Error("Create your institution first.");

      // 1) ensure a trader seat exists (founding admin = first trader)
      let traderCapId = rec.traderCapId;
      if (!traderCapId) {
        const digest = await sponsoredExecute((tx) => {
          const cap = tx.moveCall({
            target: TARGET.institution.grantTrader,
            typeArguments: [DBUSDC_TYPE],
            arguments: [
              tx.object(rec.institutionId),
              tx.object(rec.adminCapId),
              tx.pure.address(account.address),
              tx.pure.u64(DEFAULT_BOOK_SIZE),
            ],
          });
          tx.transferObjects([cap], account.address);
        });
        await suiRead.waitForTransaction({ digest });
        const full = await suiRead.getTransactionBlock({
          digest,
          options: { showObjectChanges: true },
        });
        traderCapId = createdId(full, "::institution::TraderCap");
        saveInstitution(account.address, { ...rec, traderCapId });
      }

      const side = d.side === "long" ? 0 : 1;
      const notional = toUnits(d.notional);
      const im = toUnits(d.im);
      const settle = BigInt(Math.floor(d.settlementMs));
      const expiry = BigInt(Math.floor(d.contractExpiryMs));
      const ttl = BigInt(Math.floor(d.offerTtlMs));

      // 2) propose
      if (d.entry === "direct") {
        const counterpartyId = await resolveCounterparty(d.counterparty, account.address);
        const strike = toUnits(d.strike);
        const digest = await sponsoredExecute((tx) => {
          tx.moveCall({
            target: TARGET.direct.propose,
            typeArguments: [DBUSDC_TYPE],
            arguments: [
              tx.object(rec.institutionId),
              tx.object(traderCapId!),
              tx.object(SHARED.otcAllowlist),
              tx.pure.id(counterpartyId),
              tx.pure.u8(side),
              tx.pure.string(d.asset),
              tx.pure.u64(notional),
              tx.pure.u64(strike),
              tx.pure.u64(im),
              tx.pure.u64(0n), // funding bps (forward: none)
              tx.pure.bool(false),
              tx.pure.u64(settle),
              tx.pure.u64(expiry),
              tx.pure.u64(ttl),
              tx.object(CLOCK),
            ],
          });
        });
        const offerId = await createdOf(digest, "::direct::DirectOffer<");
        // track the offer so the dashboard can pick up the OtcForward once the
        // named counterparty accepts (accepted_otc lands on the offer object)
        {
          const cur = loadInstitution(account.address);
          if (cur) {
            saveInstitution(account.address, {
              ...cur,
              directOfferIds: [...(cur.directOfferIds ?? []), offerId],
            });
          }
        }
        // default behaviour: the posted (locked) IM is rehypothecated to
        // DeepBook on open — capped to the on-chain deployable (floor) so the
        // deploy cannot abort. Non-fatal on failure, but surfaced to the caller.
        let deployWarning: string | undefined;
        if (d.rehypo && d.im > 0) {
          try {
            const fl = await readFloor(rec.institutionId).catch(() => null);
            const amt = Math.floor(Math.min(d.im, fl?.deployable ?? d.im) * 100) / 100;
            if (amt > 0) await rehypothecate(amt);
            else deployWarning = "the on-chain liquidity floor leaves nothing deployable right now";
          } catch (e) {
            deployWarning = friendlyMoveError(e instanceof Error ? e.message : String(e));
            console.warn("[fullmetal] IM auto-deploy to DeepBook failed:", e);
          }
        }
        return { digest, offerId, kind: "direct", deployWarning };
      }

      // RFQ (broadcast): no counterparty, no strike — makers compete on price
      const digest = await sponsoredExecute((tx) => {
        tx.moveCall({
          target: TARGET.rfq.open,
          typeArguments: [DBUSDC_TYPE],
          arguments: [
            tx.object(rec.institutionId),
            tx.object(traderCapId!),
            tx.pure.vector("address", []), // broadcast
            tx.pure.u8(side),
            tx.pure.string(d.asset),
            tx.pure.u64(notional),
            tx.pure.u64(im),
            tx.pure.u64(0n), // funding bps
            tx.pure.bool(false),
            tx.pure.u64(settle),
            tx.pure.u64(expiry),
            tx.pure.u64(0n), // min price (no band)
            tx.pure.u64(0n), // max price
            tx.pure.u64(ttl),
            tx.object(CLOCK),
          ],
        });
      });
      const offerId = await createdOf(digest, "::rfq::Rfq<");
      // remember the RFQ so the inbox can pull its competing quotes
      const cur = loadInstitution(account.address);
      if (cur) saveInstitution(account.address, { ...cur, rfqIds: [...(cur.rfqIds ?? []), offerId] });
      return { digest, offerId, kind: "rfq" };
    },
    [account, sponsoredExecute, rehypothecate],
  );
}

async function createdOf(digest: string, typeFragment: string): Promise<string> {
  await suiRead.waitForTransaction({ digest });
  const full = await suiRead.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  return createdId(full, typeFragment);
}

/** A 0x… institution id is used directly; anything else is treated as an org
 *  handle and resolved through the HandleRegistry. */
async function resolveCounterparty(input: string, sender: string): Promise<string> {
  const s = input.trim();
  if (s.startsWith("0x") && s.length >= 60) return s;

  const tx = new Transaction();
  tx.moveCall({
    target: TARGET.registry.resolve,
    arguments: [tx.object(SHARED.handleRegistry), tx.pure.string(s.toLowerCase())],
  });
  const r = await suiRead.devInspectTransactionBlock({ sender, transactionBlock: tx });
  const bytes = (r.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[];
  // Option<ID> BCS: 0x00 = none; 0x01 + 32 bytes = some
  if (!bytes.length || bytes[0] === 0) {
    throw new Error(`No institution registered with handle "${s}".`);
  }
  return "0x" + bytes.slice(1, 33).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Close (settle) a real OtcForward at/after maturity — permissionless, gasless.
 *  Reads the contract for both institution legs, then `otc_forward::close`:
 *  final mark-to-market, both IMs released, status → settled. Forwards can only
 *  be closed at maturity (early close isn't a forward's semantics); perps have
 *  no close path. Surfaces those as friendly errors. */
export function useClosePosition() {
  const account = useCurrentAccount();
  const sponsoredExecute = useSponsoredExecute();
  return useCallback(
    async (otcId: string): Promise<string> => {
      if (!account) throw new Error("Sign in first.");
      const o = await suiRead.getObject({ id: otcId, options: { showContent: true } });
      const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
      if (!f) throw new Error("Contract not found on-chain.");
      if (Number(f.status ?? "0") !== 0) throw new Error("This contract is already settled or liquidated.");
      const expiry = Number(f.expiry_ms ?? "0");
      if (expiry === 0) throw new Error("Perpetual contracts have no close path (they settle continuously).");
      if (Date.now() < expiry)
        throw new Error(`This forward settles at maturity — it can be closed after ${new Date(expiry).toLocaleString()}.`);
      let digest: string;
      try {
        digest = await sponsoredExecute((tx) => {
          tx.moveCall({
            target: TARGET.otc.close,
            typeArguments: [DBUSDC_TYPE],
            arguments: [
              tx.object(otcId),
              tx.object(f.inst_long),
              tx.object(f.inst_short),
              tx.object(SHARED.riskOracle),
              tx.object(SHARED.otcAllowlist),
              tx.object(CLOCK),
            ],
          });
        });
      } catch (e) {
        throw new Error(friendlyMoveError(e instanceof Error ? e.message : String(e)));
      }
      await suiRead.waitForTransaction({ digest });
      return digest;
    },
    [account, sponsoredExecute],
  );
}
