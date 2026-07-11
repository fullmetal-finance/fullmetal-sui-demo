"use client";

import { useCallback } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import { CLOCK, DBUSDC_TYPE, DEEPBOOK, OPS_ADDRESS, ORIGINAL_PACKAGE, SHARED, TARGET, fromUnits } from "./fullmetal";
import { useSponsoredExecute } from "./sponsored";
import { suiRead } from "./sui";
import { clearInstitution, loadInstitution } from "./store";
import { clearSimVenues } from "./venues";

/* "Reset desk": reclaim a signed-in demo account's test DBUSDC and wipe its
   local records so the same Google account can onboard afresh.

   Discovery is FULLY ON-CHAIN — no localStorage needed. Every institution
   carries a `contracts` table of margin reservations; enumerating its OPEN
   rows finds everything that still fences IM, and each row's target object
   tells us how to free it:
     · OtcForward past expiry      → `close` (permissionless final settlement)
     · DirectOffer past its TTL    → `reclaim_expired_direct` (permissionless)
     · Rfq Quote past its TTL      → `reclaim_expired_quote` (permissionless)
   Open, UNEXPIRED contracts stay fenced — the protocol has no early
   termination; that IM frees at expiry.

   Two-phase: `planResetDesk` does the slow reads up front; `useExecuteResetDesk`
   signs immediately on the confirm click (keeps the zkLogin session-refresh
   popup inside the user gesture). Amounts are NEVER precomputed across a state
   change — recalls/closes land first, then the exact re-read balance is
   withdrawn (DeepBook share-rounding redeems dust less than principal). */

export type ResetAction =
  | { kind: "close"; id: string; long: string; short: string; imFenced: number }
  | { kind: "reclaimDirect"; id: string; proposerInst: string; imFenced: number }
  | { kind: "reclaimQuote"; id: string; makerInst: string; imFenced: number };

export type InstPlan = {
  inst: string;
  cap: string;
  handle: string;
  paused: boolean;
  treasury: bigint;
  reserved: bigint;
  rehypothecated: bigint;
  actions: ResetAction[];
  /** IM fenced by rows we can NOT free yet (unexpired, or missing feed) */
  lockedNotes: string[];
};

export type ResetPlan = {
  address: string;
  insts: InstPlan[];
  reclaimableNow: number; // unreserved DBUSDC, before actions free more
  freeable: number; // IM the actions will unfence (settlement PnL may adjust it)
  fenced: number; // total reserved right now
  actionCount: number;
};

export type ResetSummary = {
  institutions: number;
  freed: number; // actions that executed (closes + reclaims)
  reclaimed: number; // DBUSDC returned to the faucet
  stillFenced: number;
  notes: string[];
};

// feeds registered on the demo oracle; `close` aborts for other underlyings
const CLOSEABLE_FEEDS = new Set(["SPCX", "DEMO"]);
const CLOCK_SKEW_MS = 60_000; // don't act on things expired less than a minute
const MAX_ROWS = 300; // per-institution reservation rows to scan
const ACTIONS_PER_TX = 20;

async function readInst(id: string) {
  const o = await suiRead.getObject({ id, options: { showContent: true } });
  const f = (o.data?.content as { fields?: Record<string, unknown> } | undefined)?.fields;
  if (!f) return null;
  const contractsTable = (f.contracts as { fields?: { id?: { id?: string } } } | undefined)?.fields?.id?.id;
  return {
    treasury: BigInt((f.treasury as string) ?? "0"),
    reserved: BigInt((f.reserved as string) ?? "0"),
    rehypothecated: BigInt((f.rehypothecated as string) ?? "0"),
    handle: String(f.handle ?? ""),
    paused: Boolean(f.paused),
    contractsTable: contractsTable ?? null,
  };
}

async function multiGet(ids: string[]) {
  const out: Awaited<ReturnType<typeof suiRead.multiGetObjects>> = [];
  for (let i = 0; i < ids.length; i += 50) {
    out.push(...(await suiRead.multiGetObjects({ ids: ids.slice(i, i + 50), options: { showContent: true, showType: true } })));
  }
  return out;
}

/** All OPEN margin-reservation rows in an institution's contracts table:
 *  (reservation id → fenced IM). Fully on-chain — survives wiped localStorage. */
async function openReservations(tableId: string): Promise<Map<string, bigint>> {
  const fieldIds: string[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await suiRead.getDynamicFields({ parentId: tableId, cursor: cursor ?? undefined });
    for (const f of page.data) fieldIds.push(f.objectId);
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor && fieldIds.length < MAX_ROWS);

  const rows = new Map<string, bigint>();
  for (const o of await multiGet(fieldIds)) {
    const f = (o.data?.content as { fields?: { name?: string; value?: { fields?: Record<string, unknown> } } } | undefined)?.fields;
    const ref = f?.value?.fields;
    if (!f?.name || !ref) continue;
    if (ref.open === true) rows.set(String(f.name), BigInt((ref.im_reserved as string) ?? "0"));
  }
  return rows;
}

/** Phase 1 — read-only discovery (run BEFORE asking the user to confirm). */
export async function planResetDesk(address: string): Promise<ResetPlan> {
  const caps: { inst: string; cap: string }[] = [];
  let cursor: string | null | undefined = null;
  do {
    const page = await suiRead.getOwnedObjects({
      owner: address,
      filter: { StructType: `${ORIGINAL_PACKAGE}::institution::AdminCap` },
      options: { showContent: true },
      cursor: cursor ?? undefined,
    });
    for (const o of page.data) {
      const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
      if (iid) caps.push({ inst: iid, cap: o.data!.objectId });
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);

  const now = Date.now();
  const claimed = new Set<string>(); // a contract closes once, even if both parties are ours
  const insts: InstPlan[] = [];

  for (const { inst, cap } of caps) {
    const f = await readInst(inst);
    if (!f) continue;
    const plan: InstPlan = { inst, cap, ...f, actions: [], lockedNotes: [] };

    if (f.contractsTable && f.reserved > 0n) {
      const rows = await openReservations(f.contractsTable);
      const targets = await multiGet([...rows.keys()].filter((id) => !claimed.has(id)));
      for (const o of targets) {
        const id = o.data?.objectId;
        const type = o.data?.type ?? "";
        const t = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
        if (!id || !t) continue;
        const imFenced = fromUnits(rows.get(id) ?? 0n);

        if (type.includes("::otc_forward::OtcForward<")) {
          const expiry = Number(t.expiry_ms ?? "0");
          const expired = expiry > 0 && now >= expiry + CLOCK_SKEW_MS;
          if (Number(t.status ?? "0") !== 0) continue; // terminal → row is stale
          if (!expired) {
            plan.lockedNotes.push(`${t.underlying} contract unexpired (${usdish(imFenced)} IM fenced until expiry)`);
          } else if (!CLOSEABLE_FEEDS.has(t.underlying ?? "")) {
            plan.lockedNotes.push(`${t.underlying} contract expired but its oracle feed is unregistered — ask the operator to register it`);
          } else {
            plan.actions.push({ kind: "close", id, long: t.inst_long!, short: t.inst_short!, imFenced });
            claimed.add(id);
          }
        } else if (type.includes("::direct::DirectOffer<")) {
          if (Number(t.status ?? "0") !== 0) continue;
          if (now >= Number(t.offer_expiry_ms ?? "0") + CLOCK_SKEW_MS) {
            plan.actions.push({ kind: "reclaimDirect", id, proposerInst: t.proposer_inst!, imFenced });
            claimed.add(id);
          } else {
            plan.lockedNotes.push(`direct offer live (${usdish(imFenced)} IM fenced until its TTL)`);
          }
        } else if (type.includes("::rfq::Quote<")) {
          if (Number(t.status ?? "0") !== 0) continue;
          if (now >= Number(t.quote_expiry_ms ?? "0") + CLOCK_SKEW_MS) {
            plan.actions.push({ kind: "reclaimQuote", id, makerInst: t.maker_inst!, imFenced });
            claimed.add(id);
          } else {
            plan.lockedNotes.push(`RFQ quote live (${usdish(imFenced)} IM fenced until its TTL)`);
          }
        }
        // two-way quotes / unknown types: leave fenced, surfaced via reserved
      }
    }
    insts.push(plan);
  }

  const reclaimableNow = insts.reduce((s, i) => {
    const equity = i.treasury + i.rehypothecated;
    return s + fromUnits(equity > i.reserved ? equity - i.reserved : 0n);
  }, 0);
  return {
    address,
    insts,
    reclaimableNow,
    freeable: insts.reduce((s, i) => s + i.actions.reduce((a, x) => a + x.imFenced, 0), 0),
    fenced: insts.reduce((s, i) => s + fromUnits(i.reserved), 0),
    actionCount: insts.reduce((s, i) => s + i.actions.length, 0),
  };
}

function usdish(v: number): string {
  return `$${v.toFixed(2)}`;
}

function addAction(tx: Parameters<Parameters<ReturnType<typeof useSponsoredExecute>>[0]>[0], a: ResetAction) {
  if (a.kind === "close") {
    tx.moveCall({
      target: TARGET.otc.close,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(a.id), tx.object(a.long), tx.object(a.short), tx.object(SHARED.riskOracle), tx.object(SHARED.otcAllowlist), tx.object(CLOCK)],
    });
  } else if (a.kind === "reclaimDirect") {
    tx.moveCall({
      target: TARGET.direct.reclaim,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(a.id), tx.object(a.proposerInst), tx.object(SHARED.otcAllowlist), tx.object(CLOCK)],
    });
  } else {
    tx.moveCall({
      target: TARGET.rfq.reclaimQuote,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(a.id), tx.object(a.makerInst), tx.object(SHARED.otcAllowlist), tx.object(CLOCK)],
    });
  }
}

/** Phase 2 — sign & execute a prepared plan. Call synchronously from the
 *  confirm click so the first signature stays inside the user gesture. */
export function useExecuteResetDesk() {
  const account = useCurrentAccount();
  const exec = useSponsoredExecute();

  return useCallback(
    async (plan: ResetPlan): Promise<ResetSummary> => {
      if (!account) throw new Error("Sign in first.");
      const summary: ResetSummary = { institutions: 0, freed: 0, reclaimed: 0, stillFenced: 0, notes: [] };
      if (!plan.insts.length) summary.notes.push("No institution found — cleared local records only.");

      try {
        for (const p of plan.insts) {
          summary.institutions += 1;
          const cur = (await readInst(p.inst)) ?? p;
          if (cur.paused) {
            summary.notes.push(`@${p.handle}: paused — skipped (unpause first).`);
            continue;
          }

          // step 1: free fenced IM (closes + reclaims) and recall DeepBook.
          // Batched; if a batch fails, retry actions one-by-one so a single
          // bad row can't block the rest.
          if (p.actions.length || cur.rehypothecated > 0n) {
            const batches: ResetAction[][] = [];
            for (let i = 0; i < p.actions.length; i += ACTIONS_PER_TX) batches.push(p.actions.slice(i, i + ACTIONS_PER_TX));
            if (!batches.length) batches.push([]);
            for (const [bi, batch] of batches.entries()) {
              const withRecall = bi === 0 && cur.rehypothecated > 0n;
              try {
                await exec((tx) => {
                  for (const a of batch) addAction(tx, a);
                  if (withRecall) {
                    tx.moveCall({
                      target: TARGET.rehypo.recall,
                      typeArguments: [DBUSDC_TYPE],
                      arguments: [
                        tx.object(p.inst),
                        tx.object(p.cap),
                        tx.object(DEEPBOOK.dbusdcMarginPool),
                        tx.object(DEEPBOOK.marginRegistry),
                        tx.pure.u64(cur.rehypothecated),
                        tx.object(CLOCK),
                      ],
                    });
                  }
                });
                summary.freed += batch.length;
              } catch (e) {
                // fall back to per-action so one stuck row doesn't block the rest
                for (const a of batch) {
                  try {
                    await exec((tx) => addAction(tx, a));
                    summary.freed += 1;
                  } catch (e2) {
                    summary.notes.push(`could not free ${a.kind} ${a.id.slice(0, 8)}… (${e2 instanceof Error ? e2.message.slice(0, 80) : e2})`);
                  }
                }
                if (withRecall) {
                  await exec((tx) => {
                    tx.moveCall({
                      target: TARGET.rehypo.recall,
                      typeArguments: [DBUSDC_TYPE],
                      arguments: [
                        tx.object(p.inst),
                        tx.object(p.cap),
                        tx.object(DEEPBOOK.dbusdcMarginPool),
                        tx.object(DEEPBOOK.marginRegistry),
                        tx.pure.u64(cur.rehypothecated),
                        tx.object(CLOCK),
                      ],
                    });
                  });
                }
                void e;
              }
            }
          }

          // step 2: withdraw the EXACT re-read unreserved balance → faucet
          const after = (await readInst(p.inst)) ?? cur;
          const amount = after.treasury > after.reserved ? after.treasury - after.reserved : 0n;
          if (amount > 0n) {
            await exec((tx) => {
              const coin = tx.moveCall({
                target: TARGET.institution.withdraw,
                typeArguments: [DBUSDC_TYPE],
                arguments: [tx.object(p.inst), tx.object(p.cap), tx.pure.u64(amount)],
              });
              tx.transferObjects([coin], OPS_ADDRESS);
            });
            summary.reclaimed += fromUnits(amount);
          }
          summary.stillFenced += fromUnits(after.reserved);
          if (after.reserved > 0n) {
            const why = p.lockedNotes.length ? ` (${p.lockedNotes.join("; ")})` : "";
            summary.notes.push(`@${p.handle}: ${fromUnits(after.reserved).toFixed(2)} DBUSDC stays fenced${why}.`);
          }
          clearSimVenues(p.inst);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/popup/i.test(msg)) {
          throw new Error(
            "Your sign-in session needs a refresh and the browser blocked the sign-in popup. Sign out, sign back in with Google, then click reset again.",
          );
        }
        throw e;
      }

      // wipe this account's local records → onboarding reopens
      const rec = loadInstitution(account.address);
      for (const rfqId of rec?.rfqIds ?? []) {
        if (typeof window !== "undefined") localStorage.removeItem(`fullmetal:quotes:${rfqId}`);
      }
      clearInstitution(account.address);
      return summary;
    },
    [account, exec],
  );
}
