import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, PACKAGE, SHARED } from "@/lib/fullmetal";
import { opsTx } from "@/lib/keeper-queue";
import { serverSuiClient } from "@/lib/server-sui";

export const runtime = "nodejs";

/* Auto-accept a DirectOffer on behalf of an ops-controlled MAKER desk — the
   direct-path counterpart to /api/makers (which auto-quotes RFQs). A direct
   trade only becomes an OtcForward when the counterparty accepts; the maker
   desks (Cumberland / Galaxy / Wintermute) don't sit at a browser, so the
   proposer's UI calls this and the ops key accepts. Offers to a REAL (non-maker)
   counterparty are left pending for that desk to accept itself. */

const MAKER_PREFIXES = ["0xf6de982c", "0x31089de7", "0xfb4db2ec"];

function keypair(): Ed25519Keypair {
  const fromEnv = process.env.FAUCET_SECRET_KEY;
  if (fromEnv) return Ed25519Keypair.fromSecretKey(fromEnv);
  const cfg = join(homedir(), ".sui", "sui_config");
  const addr =
    process.env.SUI_ADDRESS ??
    readFileSync(join(cfg, "client.yaml"), "utf8").match(/active_address:\s*"?(0x[0-9a-fA-F]+)"?/)?.[1];
  for (const b64 of JSON.parse(readFileSync(join(cfg, "sui.keystore"), "utf8")) as string[]) {
    const bytes = Buffer.from(b64, "base64");
    if (bytes[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error("accept-direct service has no signing key (set FAUCET_SECRET_KEY or configure ~/.sui)");
}

async function capsFor(c: SuiJsonRpcClient, owner: string, instId: string) {
  const out = { admin: "", trader: "" };
  let cursor: string | null | undefined = null;
  do {
    const page = await c.getOwnedObjects({ owner, cursor: cursor ?? undefined, options: { showType: true, showContent: true } });
    for (const o of page.data) {
      const t = o.data?.type ?? "";
      const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
      if (iid !== instId) continue;
      if (t.includes("::AdminCap")) out.admin = o.data!.objectId;
      if (t.includes("::TraderCap")) out.trader = o.data!.objectId;
    }
    cursor = page.hasNextPage ? page.nextCursor : null;
  } while (cursor);
  return out;
}

export async function POST(request: Request) {
  try {
    const { offerId } = await request.json();
    if (typeof offerId !== "string" || !offerId.startsWith("0x")) {
      return Response.json({ error: "missing offerId" }, { status: 400 });
    }

    const c = serverSuiClient();
    const o = await c.getObject({ id: offerId, options: { showContent: true } });
    const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f) return Response.json({ error: "offer not found on-chain yet — retry in a moment" }, { status: 503 });
    if (Number(f.status ?? "1") !== 0) return Response.json({ error: "this offer is no longer live (already accepted, withdrawn, or expired)" }, { status: 400 });

    const counterparty = f.counterparty_inst;
    const proposer = f.proposer_inst;
    const im = BigInt(f.im_each ?? "0");
    if (!counterparty || !proposer) return Response.json({ error: "offer is missing its parties" }, { status: 400 });

    // Only auto-accept for the ops-run maker desks. A real institution accepts
    // its own offers from its own UI (we don't hold its caps).
    if (!MAKER_PREFIXES.some((p) => counterparty.startsWith(p))) {
      return Response.json(
        { pending: true, message: "waiting for the counterparty desk to accept this offer" },
        { status: 200 },
      );
    }

    const kp = keypair();
    const signer = kp.toSuiAddress();
    const caps = await capsFor(c, signer, counterparty);
    if (!caps.admin || !caps.trader) {
      return Response.json({ error: `the service key ${signer.slice(0, 8)}… does not hold the maker desk's caps — cannot accept` }, { status: 502 });
    }

    // fund the maker's IM + a VM buffer, then accept — one serialized PTB
    const tx = new Transaction();
    tx.moveCall({
      target: `${PACKAGE}::institution::deposit_treasury`,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(counterparty), tx.object(caps.admin), coinWithBalance({ type: DBUSDC_TYPE, balance: im + 5_000_000n })],
    });
    tx.moveCall({
      target: `${PACKAGE}::direct::accept_direct`,
      typeArguments: [DBUSDC_TYPE],
      arguments: [
        tx.object(offerId),
        tx.object(counterparty),
        tx.object(caps.trader),
        tx.object(proposer),
        tx.object(SHARED.otcAllowlist),
        tx.object(CLOCK),
      ],
    });
    const r = await opsTx(() => c.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true, showObjectChanges: true } }));
    await c.waitForTransaction({ digest: r.digest });
    if (r.effects?.status.status !== "success") {
      return Response.json({ error: `accept failed: ${r.effects?.status.error}` }, { status: 502 });
    }
    const otc = (r.objectChanges ?? []).find(
      (x) => (x as { type?: string }).type === "created" && ((x as { objectType?: string }).objectType ?? "").includes("::otc_forward::OtcForward<"),
    ) as { objectId?: string } | undefined;
    if (!otc?.objectId) return Response.json({ error: "accepted, but the OtcForward id was not found in the tx" }, { status: 502 });

    return Response.json({ otcId: otc.objectId, digest: r.digest });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
