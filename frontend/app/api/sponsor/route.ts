import { EnokiClient } from "@mysten/enoki";

import { enokiErrorDetail } from "@/lib/enoki-error";
import { ALL_MOVE_TARGETS } from "@/lib/fullmetal";

/* SERVER ONLY. Sponsored transactions can only be created with a PRIVATE Enoki
   key (it spends the sponsor's gas), so this never runs in the browser.

   We use the `sender` branch (not `jwt`): the dApp Kit Enoki wallet manages the
   zkLogin keypair client-side, so we pass the connected address explicitly.
   (The `jwt` branch is for Enoki-MANAGED zkLogin and returns a zero sender to a
   client-managed wallet → the re-built tx ends up signed by 0x0.) The gas pool
   is scoped to Fullmetal's own move-call targets. */
export async function POST(request: Request) {
  const key = process.env.ENOKI_PRIVATE_API_KEY;
  if (!key) {
    return Response.json({ error: "ENOKI_PRIVATE_API_KEY not configured" }, { status: 500 });
  }
  try {
    const { network, transactionKindBytes, sender } = await request.json();
    if (!transactionKindBytes || !sender) {
      return Response.json({ error: "missing transactionKindBytes or sender" }, { status: 400 });
    }
    const enoki = new EnokiClient({ apiKey: key });
    const sponsored = await enoki.createSponsoredTransaction({
      network: network ?? "testnet",
      transactionKindBytes,
      sender,
      allowedMoveCallTargets: ALL_MOVE_TARGETS,
      allowedAddresses: [sender],
    });
    return Response.json({ bytes: sponsored.bytes, digest: sponsored.digest });
  } catch (e) {
    return Response.json(enokiErrorDetail(e), { status: 502 });
  }
}
