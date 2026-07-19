import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, PACKAGE, SHARED, TARGET } from "@/lib/fullmetal";
import { opsTx } from "@/lib/keeper-queue";
import { serverSuiClient } from "@/lib/server-sui";

export const runtime = "nodejs";

/* Maker-desk service.

   GET  ?rfqIds=a,b,c → chain-truth discovery: every LIVE quote standing against
        those RFQs, plus each RFQ's own state. The inbox polls this, so quotes
        survive page refreshes, lost responses, and other browsers — the chain
        is the source of truth, localStorage is not involved.

   POST {rfqId}       → ensure-quotes (idempotent): desks that already have a
        live quote on the RFQ are skipped; missing ones are funded (shortfall
        only) and quote at the LIVE oracle mark ± a per-desk spread, on the
        correct side of the requester. Partial failures are reported per desk;
        zero quotes → a real HTTP error with the reason (never a silent 200). */

// three desks the demo operator controls; spread in bps off the live mark —
// the requester pays the spread (long → makers ask above, short → bid below)
const MAKERS = [
  { instPrefix: "0xf6de982c", org: "Cumberland", spreadBps: 40 },
  { instPrefix: "0x31089de7", org: "Galaxy Digital", spreadBps: 100 },
  { instPrefix: "0xfb4db2ec", org: "Wintermute", spreadBps: 175 },
];

const QUOTE_TYPE_FRAGMENT = "::rfq::Quote<";

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
  throw new Error("maker service has no signing key (set FAUCET_SECRET_KEY or configure ~/.sui)");
}

type Fields = Record<string, string>;
const fieldsOf = (o: { data?: { content?: unknown } | null }): Fields | null =>
  ((o.data?.content as { fields?: Fields } | undefined)?.fields ?? null);

export type DeskQuoteWire = { org: string; quoteId: string; price: number; im: number; expiresMs: number };
export type RfqSectionWire = {
  rfqId: string;
  status: number; // 0 open · 1 filled · 2 cancelled · -1 unreadable
  expiryMs: number;
  side: "long" | "short";
  underlying: string;
  notional: number; // units of underlying
  imEach: number; // USD
  quotes: DeskQuoteWire[];
};

function orgOf(makerInst: string): string {
  return MAKERS.find((m) => makerInst.startsWith(m.instPrefix))?.org ?? `desk ${makerInst.slice(0, 8)}…`;
}

/* Per-process memo for the submit_quote tx → Quote-object resolution. A tx's
   created objects are immutable, so entries never invalidate; digests whose
   effects the RPC has pruned (it then throws "unable to derive … changes")
   are skipped forever. */
const quoteIdsByDigest = new Map<string, string[]>();
const prunedDigests = new Set<string>();

async function recentQuoteIds(c: SuiJsonRpcClient): Promise<string[]> {
  // digests-only query — asking for objectChanges here makes the RPC throw as
  // soon as ONE tx in the window has pruned effects
  const page = await c.queryTransactionBlocks({
    filter: { MoveFunction: { package: PACKAGE, module: "rfq", function: "submit_quote" } },
    order: "descending",
    limit: 30,
  });
  const digests = page.data.map((t) => t.digest);
  await Promise.all(
    digests
      .filter((d) => !quoteIdsByDigest.has(d) && !prunedDigests.has(d))
      .map(async (digest) => {
        try {
          const t = await c.getTransactionBlock({ digest, options: { showObjectChanges: true } });
          quoteIdsByDigest.set(
            digest,
            (t.objectChanges ?? [])
              .filter(
                (o) =>
                  (o as { type?: string }).type === "created" &&
                  ((o as { objectType?: string }).objectType ?? "").includes(QUOTE_TYPE_FRAGMENT),
              )
              .map((o) => (o as { objectId: string }).objectId),
          );
        } catch {
          prunedDigests.add(digest);
        }
      }),
  );
  return digests.flatMap((d) => quoteIdsByDigest.get(d) ?? []);
}

/** Chain-truth: RFQ states + all LIVE quotes standing against them. Quotes are
 *  their own shared objects with no on-chain index by RFQ, so we recover them
 *  from the recent submit_quote transactions' created objects. */
async function discover(c: SuiJsonRpcClient, rfqIds: string[]): Promise<RfqSectionWire[]> {
  const [rfqObjs, quoteIds] = await Promise.all([
    c.multiGetObjects({ ids: rfqIds, options: { showContent: true } }),
    recentQuoteIds(c),
  ]);
  const quoteObjs = quoteIds.length
    ? await c.multiGetObjects({ ids: quoteIds, options: { showContent: true } })
    : [];

  const now = Date.now();
  const byRfq = new Map<string, DeskQuoteWire[]>();
  for (const q of quoteObjs) {
    const f = fieldsOf(q);
    if (!f) continue;
    const live = Number(f.status ?? "1") === 0 && Number(f.quote_expiry_ms ?? "0") > now;
    if (!live) continue;
    const list = byRfq.get(f.rfq_id) ?? [];
    list.push({
      org: orgOf(f.maker_inst ?? ""),
      quoteId: q.data!.objectId,
      price: Number(f.entry_price) / 1e6,
      im: Number(f.im_each) / 1e6,
      expiresMs: Number(f.quote_expiry_ms),
    });
    byRfq.set(f.rfq_id, list);
  }

  return rfqIds.map((rfqId, i) => {
    const f = fieldsOf(rfqObjs[i] ?? {});
    if (!f) {
      return { rfqId, status: -1, expiryMs: 0, side: "long" as const, underlying: "?", notional: 0, imEach: 0, quotes: [] };
    }
    return {
      rfqId,
      status: Number(f.status ?? "0"),
      expiryMs: Number(f.rfq_expiry_ms ?? "0"),
      side: Number(f.requester_side ?? "0") === 0 ? ("long" as const) : ("short" as const),
      underlying: f.underlying ?? "?",
      notional: Number(f.notional ?? "0") / 1e6,
      imEach: Number(f.im_each ?? "0") / 1e6,
      quotes: byRfq.get(rfqId) ?? [],
    };
  });
}

function decodeU64(bytes?: number[]): bigint {
  let v = 0n;
  const b = bytes ?? [];
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) + BigInt(b[i]);
  return v;
}

/** Live oracle mark for `symbol` — the same feed contracts settle on. */
async function liveMark(c: SuiJsonRpcClient, symbol: string): Promise<number | null> {
  const tx = new Transaction();
  tx.moveCall({ target: TARGET.oracle.hasFeed, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(symbol)] });
  tx.moveCall({ target: TARGET.oracle.price, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(symbol)] });
  const r = await c.devInspectTransactionBlock({ sender: SHARED.riskOracle, transactionBlock: tx });
  const has = (r.results?.[0]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
  if (!has) return null;
  return Number(decodeU64(r.results?.[1]?.returnValues?.[0]?.[0] as number[] | undefined)) / 1e6;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const raw = url.searchParams.get("rfqIds") ?? url.searchParams.get("rfqId") ?? "";
    const rfqIds = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 6);
    if (!rfqIds.length) return Response.json({ error: "missing rfqIds" }, { status: 400 });
    const sections = await discover(serverSuiClient(), rfqIds);
    return Response.json({ sections });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { rfqId } = await request.json();
    if (typeof rfqId !== "string") return Response.json({ error: "missing rfqId" }, { status: 400 });

    const c = serverSuiClient();
    const kp = keypair();
    const signer = kp.toSuiAddress();

    const [section] = await discover(c, [rfqId]);
    if (section.status === -1) return Response.json({ error: "RFQ not found on-chain yet — retry in a few seconds" }, { status: 503 });
    if (section.status === 1) return Response.json({ error: "this RFQ is already filled — the winning quote opened a contract", rfq: section }, { status: 400 });
    if (section.status === 2) return Response.json({ error: "this RFQ was cancelled — broadcast a new one", rfq: section }, { status: 400 });
    const now = Date.now();
    if (now >= section.expiryMs) return Response.json({ error: "this RFQ has expired — broadcast a new one", rfq: section }, { status: 400 });
    if (section.expiryMs - now < 90_000) {
      return Response.json({ error: "the RFQ expires in under 90s — too tight for firm quotes; broadcast with a longer offer TTL", rfq: section }, { status: 400 });
    }

    const mark = await liveMark(c, section.underlying);
    if (mark == null || mark <= 0) {
      return Response.json(
        { error: `the desks have no oracle feed for "${section.underlying}" and cannot price it — the demo feed is SPCX`, rfq: section },
        { status: 400 },
      );
    }

    // quotes must die before the RFQ does (on-chain assert): 30s safety margin
    const ttlMs = BigInt(Math.min(section.expiryMs - now - 30_000, 1_800_000));
    const dir = section.side === "long" ? 1 : -1; // requester long → makers ask above mark

    // resolve maker caps owned by THIS signer — a wrong key (e.g. a hosted
    // deployment with a different FAUCET_SECRET_KEY) must fail loudly, not 500
    const caps: Record<string, { inst: string; admin: string; trader: string }> = {};
    let cursor: string | null | undefined = null;
    do {
      const res = await c.getOwnedObjects({ owner: signer, cursor: cursor ?? undefined, options: { showType: true, showContent: true } });
      for (const o of res.data) {
        const t = o.data?.type ?? "";
        const iid = fieldsOf(o)?.institution_id;
        if (!iid) continue;
        caps[iid] ??= { inst: iid, admin: "", trader: "" };
        if (t.includes("::AdminCap")) caps[iid].admin = o.data!.objectId;
        if (t.includes("::TraderCap")) caps[iid].trader = o.data!.objectId;
      }
      cursor = res.hasNextPage ? res.nextCursor : null;
    } while (cursor);

    const alreadyQuoted = new Set(section.quotes.map((q) => q.org));
    const pending = MAKERS.filter((m) => !alreadyQuoted.has(m.org));
    const imUnits = BigInt(Math.round(section.imEach * 1e6));

    // fuel pre-flight: worst case every pending desk needs a full IM top-up
    if (pending.length) {
      const bal = await c.getBalance({ owner: signer, coinType: DBUSDC_TYPE });
      const worstCase = pending.length * (section.imEach + 2);
      if (Number(bal.totalBalance) / 1e6 < worstCase) {
        return Response.json(
          {
            error: `maker wallet ${signer.slice(0, 8)}… holds $${(Number(bal.totalBalance) / 1e6).toFixed(2)} DBUSDC but may need $${worstCase.toFixed(2)} to collateralize ${pending.length} quotes — top it up (scripts: swap-dbusdc.ts / sweep-desks.ts)`,
            rfq: section,
          },
          { status: 502 },
        );
      }
    }

    const failed: { org: string; error: string }[] = [];
    const fresh: DeskQuoteWire[] = [];

    for (const m of pending) {
      try {
        const e = Object.values(caps).find((v) => v.inst.startsWith(m.instPrefix));
        if (!e?.admin || !e.trader) throw new Error(`caps for ${m.org} are not owned by the service key ${signer.slice(0, 8)}…`);

        // fund only the shortfall between the desk's free treasury and the IM
        const instObj = await c.getObject({ id: e.inst, options: { showContent: true } });
        const fi = fieldsOf(instObj) ?? {};
        const freeUnits = BigInt(fi.treasury ?? "0") - BigInt(fi.reserved ?? "0");
        const shortfall = imUnits + 1_000_000n - (freeUnits > 0n ? freeUnits : 0n);
        if (shortfall > 0n) {
          const fund = new Transaction();
          fund.moveCall({
            target: `${PACKAGE}::institution::deposit_treasury`,
            typeArguments: [DBUSDC_TYPE],
            arguments: [fund.object(e.inst), fund.object(e.admin), coinWithBalance({ type: DBUSDC_TYPE, balance: shortfall })],
          });
          const fr = await opsTx(() => c.signAndExecuteTransaction({ signer: kp, transaction: fund, options: { showEffects: true } }));
          await c.waitForTransaction({ digest: fr.digest });
          if (fr.effects?.status.status !== "success") throw new Error(`treasury top-up failed: ${fr.effects?.status.error}`);
        }

        const price = Math.round(mark * (1 + (dir * m.spreadBps) / 10_000) * 1e6);
        const q = new Transaction();
        q.moveCall({
          target: `${PACKAGE}::rfq::submit_quote`,
          typeArguments: [DBUSDC_TYPE],
          arguments: [
            q.object(rfqId),
            q.object(e.inst),
            q.object(e.trader),
            q.object(SHARED.otcAllowlist),
            q.pure.u64(BigInt(price)),
            q.pure.u64(ttlMs),
            q.object(CLOCK),
          ],
        });
        const r = await opsTx(() => c.signAndExecuteTransaction({ signer: kp, transaction: q, options: { showEffects: true, showObjectChanges: true } }));
        await c.waitForTransaction({ digest: r.digest });
        if (r.effects?.status.status !== "success") throw new Error(r.effects?.status.error ?? "submit_quote failed");
        const created = (r.objectChanges ?? []).find(
          (o) =>
            (o as { type?: string }).type === "created" &&
            ((o as { objectType?: string }).objectType ?? "").includes(QUOTE_TYPE_FRAGMENT),
        ) as { objectId?: string } | undefined;
        if (!created?.objectId) throw new Error("quote object not found in tx effects");
        fresh.push({ org: m.org, quoteId: created.objectId, price: price / 1e6, im: section.imEach, expiresMs: now + Number(ttlMs) });
      } catch (err) {
        failed.push({ org: m.org, error: err instanceof Error ? err.message : String(err) });
      }
    }

    const quotes = [...section.quotes, ...fresh];
    if (!quotes.length) {
      return Response.json(
        { error: `no desk could quote — ${failed.map((f) => `${f.org}: ${f.error}`).join(" · ")}`, failed, rfq: section },
        { status: 502 },
      );
    }
    return Response.json({ quotes, failed: failed.length ? failed : undefined, rfq: section, mark });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
