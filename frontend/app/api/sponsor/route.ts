import { EnokiClient } from "@mysten/enoki";

import { enokiErrorDetail } from "@/lib/enoki-error";

/* SERVER ONLY. Sponsored transactions can only be created with a PRIVATE Enoki
   key (it spends the sponsor's gas), so this never runs in the browser. The
   client sends the transaction-kind bytes + its zkLogin JWT; Enoki fills in gas
   and returns full tx bytes for the client to sign. */
export async function POST(request: Request) {
  const key = process.env.ENOKI_PRIVATE_API_KEY;
  if (!key) {
    return Response.json({ error: "ENOKI_PRIVATE_API_KEY not configured" }, { status: 500 });
  }
  try {
    const { network, transactionKindBytes, jwt } = await request.json();
    if (!transactionKindBytes || !jwt) {
      return Response.json({ error: "missing transactionKindBytes or jwt" }, { status: 400 });
    }
    const enoki = new EnokiClient({ apiKey: key });
    const sponsored = await enoki.createSponsoredTransaction({
      network: network ?? "testnet",
      transactionKindBytes,
      jwt,
    });
    return Response.json({ bytes: sponsored.bytes, digest: sponsored.digest });
  } catch (e) {
    return Response.json(enokiErrorDetail(e), { status: 502 });
  }
}
