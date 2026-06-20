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

/** Returns an executor that runs a Move PTB as a GASLESS sponsored transaction.
 *  The browser builds the tx-kind bytes and signs, but gas sponsorship runs on
 *  the server (the PRIVATE Enoki key never reaches the client): build kind bytes
 *  → POST /api/sponsor (server fills gas, sets sender) → the zkLogin wallet signs
 *  the sponsor's bytes → POST /api/execute (server executes). The sender is the
 *  connected zkLogin address, passed explicitly (Enoki's `sender` branch).
 *  Resolves to the tx digest. */
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
      const kindBytes = await tx.build({ client, onlyTransactionKind: true });

      const sponsored = await postJson<{ bytes: string; digest: string }>(
        "/api/sponsor",
        {
          network,
          transactionKindBytes: toBase64(kindBytes),
          sender: account.address,
        },
      );

      const { signature } = await dAppKit.signTransaction({
        transaction: sponsored.bytes,
      });

      const executed = await postJson<{ digest: string }>("/api/execute", {
        digest: sponsored.digest,
        signature,
      });
      return executed.digest;
    },
    [dAppKit, client, network, account],
  );
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `${url} failed (${res.status})`);
  }
  return data as T;
}
