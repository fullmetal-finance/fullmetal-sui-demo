/* Read-only JSON-RPC client for queries (tx read-back, object reads). Signing +
   sponsored execution go through dApp Kit's gRPC client + Enoki; this is only
   for reads, where the JSON-RPC API is the simplest battle-tested surface.

   The official fullnode (fullnode.testnet.sui.io) removed JSON-RPC (gRPC-only
   now, 404 on JSON-RPC bodies), so reads go to a public endpoint that still
   serves it. Override with NEXT_PUBLIC_SUI_RPC_URL. */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

export const TESTNET_JSONRPC_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ?? "https://rpc-testnet.suiscan.xyz:443";

export const suiRead = new SuiJsonRpcClient({
  network: "testnet",
  url: TESTNET_JSONRPC_URL,
});

/** First `created` object whose type contains `typeFragment`. */
export function createdId(
  res: { objectChanges?: unknown[] | null },
  typeFragment: string,
): string {
  const c = (res.objectChanges ?? []).find(
    (o) =>
      (o as { type?: string }).type === "created" &&
      ((o as { objectType?: string }).objectType ?? "").includes(typeFragment),
  );
  if (!c) throw new Error(`no created object matching ${typeFragment}`);
  return (c as { objectId: string }).objectId;
}
