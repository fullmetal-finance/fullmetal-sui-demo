"use client";

import { useCallback } from "react";
import {
  useCurrentAccount,
  useCurrentClient,
  useCurrentNetwork,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

import { suiRead } from "./sui";

/** Returns an executor that runs a Move PTB as a GASLESS sponsored transaction.
 *  The browser builds the tx-kind bytes and signs, but gas sponsorship runs on
 *  the server (the PRIVATE Enoki key never reaches the client): build kind bytes
 *  → POST /api/sponsor (server fills gas, sets sender) → the zkLogin wallet signs
 *  the sponsor's bytes → POST /api/execute (server executes). The sender is the
 *  connected zkLogin address, passed explicitly (Enoki's `sender` branch).
 *
 *  Hardened against Enoki's intermittent execute failures (observed on testnet:
 *  execute hangs ~30s → 502, and the hang CONSUMES the sponsorship, so re-posting
 *  the same signature returns "Sponsored transaction not found"). The recovery
 *  is a FULL-CYCLE retry on the same Enoki rails: verify the digest did not land
 *  on-chain, then request a FRESH sponsorship for the same kind bytes, re-sign
 *  (silent with a live session), and execute that. Sponsor-side 5xxs are retried
 *  with backoff (a failed sponsorship leaves nothing behind). Resolves to the
 *  tx digest.
 *
 *  ALTERNATE PATH — self-paid gas, used ONLY while Enoki is failing: when the
 *  full-cycle retry still can't get a tx through Enoki's infra (and the failure
 *  isn't the tx's own fault — those surface as 4xx and are rethrown), the ops
 *  wallet tops the zkLogin address up with SUI (/api/gas), the SAME PTB is
 *  rebuilt as a normal self-paid tx, the wallet signs it, and it goes out over
 *  plain JSON-RPC — no Enoki leg at all. A short cooldown then routes
 *  subsequent actions straight to the fallback so each click doesn't re-lose
 *  ~60s to Enoki's hang-then-502, after which Enoki gets first shot again. */
const ENOKI_RETRY_AFTER_MS = 120_000;
let enokiDownUntil = 0;

export function useSponsoredExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const network = useCurrentNetwork();
  const account = useCurrentAccount();

  return useCallback(
    async (build: (tx: Transaction) => void): Promise<string> => {
      if (!account) throw new Error("Sign in first.");
      const sender = account.address;

      // Enoki was just observed failing — don't re-probe it on every action.
      if (Date.now() < enokiDownUntil) return selfPaidExecute(dAppKit, sender, build);

      const tx = new Transaction();
      build(tx);
      // Set the sender so sender-dependent intents (e.g. coinWithBalance picking
      // the user's coins) resolve at build time. onlyTransactionKind still emits
      // only the kind; Enoki wraps in the sender + sponsor gas.
      tx.setSenderIfNotSet(sender);
      const kindBytes = toBase64(await tx.build({ client, onlyTransactionKind: true }));

      let lastErr: unknown;
      let prevDigest: string | null = null;
      for (let cycle = 0; cycle < 2; cycle++) {
        let sponsored: { bytes: string; digest: string };
        try {
          sponsored = await postJson<{ bytes: string; digest: string }>(
            "/api/sponsor",
            { network, transactionKindBytes: kindBytes, sender },
            3, // transient-5xx retries: sponsorship failures leave nothing behind
          );
        } catch (e) {
          // 4xx = the TX itself failed Enoki's dry-run — self-paid gas cannot
          // fix that, so surface it. Anything else is Enoki infra → fallback.
          if (e instanceof ApiError && e.status < 500) throw e;
          lastErr = e;
          break;
        }

        const { signature } = await dAppKit.signTransaction({
          transaction: sponsored.bytes,
        });

        // guard against double-execution: if the PREVIOUS cycle's hung attempt
        // landed late while we were re-sponsoring, return it instead of
        // submitting the same intent twice.
        if (prevDigest && (await landedOnChain(prevDigest, 3_000))) return prevDigest;

        try {
          const executed = await postJson<{ digest: string }>("/api/execute", {
            digest: sponsored.digest,
            signature,
          });
          return executed.digest;
        } catch (e) {
          lastErr = e;
          // never trust a gateway error blindly — the tx may have landed even
          // though Enoki's response didn't make it back
          if (await landedOnChain(sponsored.digest, 25_000)) return sponsored.digest;
          prevDigest = sponsored.digest;
        }
      }

      // Enoki's rails are failing even after the full-cycle retry (the testnet
      // outage signature: sponsor 200 → execute hangs ~30s → 502). One last
      // landed-check, then switch to the alternate path.
      if (prevDigest && (await landedOnChain(prevDigest, 3_000))) return prevDigest;
      enokiDownUntil = Date.now() + ENOKI_RETRY_AFTER_MS;
      console.warn("[fullmetal] Enoki sponsorship failing — falling back to self-paid gas.", lastErr);
      return selfPaidExecute(dAppKit, sender, build);
    },
    [dAppKit, client, network, account],
  );
}

/** The alternate path: same PTB, but the zkLogin address pays its own gas
 *  (topped up from the ops wallet) and the tx is executed over plain JSON-RPC,
 *  bypassing Enoki entirely. */
async function selfPaidExecute(
  dAppKit: ReturnType<typeof useDAppKit>,
  sender: string,
  build: (tx: Transaction) => void,
): Promise<string> {
  // server sends a sliver of SUI from the ops wallet if the balance is short
  await postJson("/api/gas", { address: sender }, 2);

  const tx = new Transaction();
  build(tx);
  tx.setSenderIfNotSet(sender);
  const bytes = toBase64(await tx.build({ client: suiRead }));

  const signed = await dAppKit.signTransaction({ transaction: bytes });
  const res = await suiRead.executeTransactionBlock({
    transactionBlock: signed.bytes,
    signature: signed.signature,
    options: { showEffects: true },
  });
  if (res.effects?.status.status !== "success") {
    throw new Error(res.effects?.status.error ?? "transaction failed on-chain");
  }
  // wait for indexing so follow-up reads see the effects
  await suiRead.waitForTransaction({ digest: res.digest, timeout: 30_000, pollInterval: 1_000 });
  return res.digest;
}

/** Did the sponsored digest reach finality despite the API error? */
async function landedOnChain(digest: string, timeout: number): Promise<boolean> {
  try {
    await suiRead.waitForTransaction({ digest, timeout, pollInterval: 1_000 });
    return true;
  } catch {
    return false;
  }
}

class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function postJson<T>(url: string, body: unknown, tries = 1): Promise<T> {
  let lastErr: Error | null = null;
  for (let i = 0; i < tries; i++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      await backoff(i);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok) return data as T;
    const err = data as { error?: string; code?: string };
    lastErr = new ApiError(err.error ?? `${url} failed (${res.status})`, res.status, err.code);
    if (res.status < 500) throw lastErr; // 4xx is real — don't hammer it
    await backoff(i);
  }
  throw lastErr ?? new Error(`${url} failed`);
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 700 * (attempt + 1) * (attempt + 1)));
}
