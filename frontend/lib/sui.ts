/* Read-only JSON-RPC client for queries (tx read-back, object reads). Signing +
   sponsored execution go through dApp Kit's gRPC client + Enoki; this is only
   for reads, where the JSON-RPC API is the simplest battle-tested surface. */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

export const suiRead = new SuiJsonRpcClient({
  network: "testnet",
  url: getJsonRpcFullnodeUrl("testnet"),
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
