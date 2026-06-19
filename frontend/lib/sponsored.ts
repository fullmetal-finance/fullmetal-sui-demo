"use client";

import { useCallback } from "react";
import {
  useCurrentClient,
  useCurrentNetwork,
  useCurrentWallet,
  useDAppKit,
} from "@mysten/dapp-kit-react";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { getSession } from "@mysten/enoki";

/** Returns an executor that runs a Move PTB as a GASLESS sponsored transaction.
 *  The browser builds the tx-kind bytes and signs, but gas sponsorship runs on
 *  the server (the PRIVATE Enoki key never reaches the client): build kind bytes
 *  → POST /api/sponsor (server fills gas) → zkLogin wallet signs the bytes →
 *  POST /api/execute (server executes). Resolves to the tx digest. */
export function useSponsoredExecute() {
  const dAppKit = useDAppKit();
  const client = useCurrentClient();
  const network = useCurrentNetwork();
  const wallet = useCurrentWallet();

  return useCallback(
    async (build: (tx: Transaction) => void): Promise<string> => {
      if (!wallet) throw new Error("Sign in first.");
      const session = await getSession(wallet);
      if (!session?.jwt) throw new Error("No active Enoki session.");

      const tx = new Transaction();
      build(tx);
      // onlyTransactionKind → no gas data; the sponsor (server) fills it in.
      const kindBytes = await tx.build({ client, onlyTransactionKind: true });

      const sponsored = await postJson<{ bytes: string; digest: string }>(
        "/api/sponsor",
        {
          network,
          transactionKindBytes: toBase64(kindBytes),
          jwt: session.jwt,
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
    [dAppKit, client, network, wallet],
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
