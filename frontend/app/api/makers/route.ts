import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, PACKAGE, SHARED } from "@/lib/fullmetal";

export const runtime = "nodejs";

const ACTIVE = "0x6849af55b4f2f429cb2665ec9f4d42c17eecc76211f14caf959903ad786d5576";

// three desks the demo operator controls, mapped to display names + prices ($)
const MAKERS = [
  { instPrefix: "0xf6de982c", org: "Cumberland", price: 184.1 },
  { instPrefix: "0x31089de7", org: "Galaxy Digital", price: 185.0 },
  { instPrefix: "0xfb4db2ec", org: "Wintermute", price: 185.4 },
];

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
  throw new Error("no maker key in ~/.sui");
}

type Caps = Record<string, { inst: string; admin: string; trader: string }>;

async function caps(c: SuiJsonRpcClient): Promise<Caps> {
  let cursor: string | null | undefined = null;
  const out: Caps = {};
  do {
    const res = await c.getOwnedObjects({ owner: ACTIVE, cursor: cursor ?? undefined, options: { showType: true, showContent: true } });
    for (const o of res.data) {
      const t = o.data?.type ?? "";
      const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
      if (!iid) continue;
      out[iid] ??= { inst: iid, admin: "", trader: "" };
      if (t.includes("::AdminCap")) out[iid].admin = o.data!.objectId;
      if (t.includes("::TraderCap")) out[iid].trader = o.data!.objectId;
    }
    cursor = res.hasNextPage ? res.nextCursor : null;
  } while (cursor);
  return out;
}

export async function POST(request: Request) {
  try {
    const { rfqId } = await request.json();
    if (typeof rfqId !== "string") return Response.json({ error: "missing rfqId" }, { status: 400 });

    const c = new SuiJsonRpcClient({ network: "testnet", url: getJsonRpcFullnodeUrl("testnet") });
    const kp = keypair();

    const rfq = await c.getObject({ id: rfqId, options: { showContent: true } });
    const rf = (rfq.data?.content as { fields?: Record<string, string> } | undefined)?.fields ?? {};
    const imUnits = BigInt(rf.im_each ?? "5000000");
    const im = Number(imUnits) / 1e6;
    const rfqExpiry = Number(rf.rfq_expiry_ms ?? "0");
    const clk = await c.getObject({ id: CLOCK, options: { showContent: true } });
    const now = Number((clk.data?.content as { fields?: { timestamp_ms?: string } } | undefined)?.fields?.timestamp_ms ?? "0");
    const ttl = BigInt(Math.max(60_000, Math.min(rfqExpiry - now - 30_000, 1_800_000)));
    const expiresMin = Math.max(1, Math.floor(Number(ttl) / 60000));

    const capMap = await caps(c);
    const quotes: { org: string; quoteId: string; price: number; im: number; ttl: string }[] = [];

    for (const m of MAKERS) {
      const e = Object.values(capMap).find((v) => v.inst.startsWith(m.instPrefix));
      if (!e?.admin || !e.trader) continue;

      const fund = new Transaction();
      fund.moveCall({
        target: `${PACKAGE}::institution::deposit_treasury`,
        typeArguments: [DBUSDC_TYPE],
        arguments: [fund.object(e.inst), fund.object(e.admin), coinWithBalance({ type: DBUSDC_TYPE, balance: imUnits + 2_000_000n })],
      });
      await c.waitForTransaction({ digest: (await c.signAndExecuteTransaction({ signer: kp, transaction: fund })).digest });

      const q = new Transaction();
      q.moveCall({
        target: `${PACKAGE}::rfq::submit_quote`,
        typeArguments: [DBUSDC_TYPE],
        arguments: [q.object(rfqId), q.object(e.inst), q.object(e.trader), q.object(SHARED.otcAllowlist), q.pure.u64(BigInt(Math.round(m.price * 1e6))), q.pure.u64(ttl), q.object(CLOCK)],
      });
      const r = await c.signAndExecuteTransaction({ signer: kp, transaction: q, options: { showEffects: true, showObjectChanges: true } });
      await c.waitForTransaction({ digest: r.digest });
      if (r.effects?.status.status !== "success") continue;
      const quoteId = (r.objectChanges ?? []).find((o) => (o as { type?: string }).type === "created" && ((o as { objectType?: string }).objectType ?? "").includes("::rfq::Quote<")) as { objectId?: string } | undefined;
      if (quoteId?.objectId) quotes.push({ org: m.org, quoteId: quoteId.objectId, price: m.price, im, ttl: `${expiresMin}:00` });
    }

    return Response.json({ quotes });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
