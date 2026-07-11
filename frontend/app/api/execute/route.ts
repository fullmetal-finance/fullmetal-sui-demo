import { EnokiClient } from "@mysten/enoki";

import { enokiErrorDetail } from "@/lib/enoki-error";

/* SERVER ONLY. After the client signs the sponsor's bytes, Enoki executes the
   transaction (sponsor pays gas). Returns the on-chain digest. */
export async function POST(request: Request) {
  const key = process.env.ENOKI_PRIVATE_API_KEY;
  if (!key) {
    return Response.json({ error: "ENOKI_PRIVATE_API_KEY not configured" }, { status: 500 });
  }
  try {
    const { digest, signature } = await request.json();
    if (!digest || !signature) {
      return Response.json({ error: "missing digest or signature" }, { status: 400 });
    }
    const enoki = new EnokiClient({ apiKey: key });
    const res = await enoki.executeSponsoredTransaction({ digest, signature });
    return Response.json({ digest: res.digest });
  } catch (e) {
    const detail = enokiErrorDetail(e);
    // 4xx from Enoki (e.g. "Sponsored transaction not found" after a hung
    // execute consumed the sponsorship) is not an infra 502 — pass it as 400.
    const status = detail.enokiStatus && detail.enokiStatus < 500 ? 400 : 502;
    return Response.json(detail, { status });
  }
}
