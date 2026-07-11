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
 *  tx digest. */
export function useSponsoredExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const network = useCurrentNetwork();
  const account = useCurrentAccount();

  return useCallback(
    async (build: (tx: Transaction) => void): Promise<string> => {
      if (!account) throw new Error("Sign in first.");

      const tx = new Transaction();
      build(tx);
      // Set the sender so sender-dependent intents (e.g. coinWithBalance picking
      // the user's coins) resolve at build time. onlyTransactionKind still emits
      // only the kind; Enoki wraps in the sender + sponsor gas.
      tx.setSenderIfNotSet(account.address);
      const kindBytes = toBase64(await tx.build({ client, onlyTransactionKind: true }));

      let lastErr: unknown;
      let prevDigest: string | null = null;
      for (let cycle = 0; cycle < 2; cycle++) {
        const sponsored = await postJson<{ bytes: string; digest: string }>(
          "/api/sponsor",
          { network, transactionKindBytes: kindBytes, sender: account.address },
          3, // transient-5xx retries: sponsorship failures leave nothing behind
        );

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
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
    [dAppKit, client, network, account],
  );
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
    lastErr = new Error((data as { error?: string }).error ?? `${url} failed (${res.status})`);
    if (res.status < 500) throw lastErr; // 4xx is real — don't hammer it
    await backoff(i);
  }
  throw lastErr ?? new Error(`${url} failed`);
}

function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, 700 * (attempt + 1) * (attempt + 1)));
}
