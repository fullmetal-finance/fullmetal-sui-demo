import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, DEEPBOOK, SHARED, SPCX, SPCX_VOL, TARGET } from "@/lib/fullmetal";
import { serverSuiClient } from "@/lib/server-sui";

export const runtime = "nodejs";

/* The keeper/oracle admin caps live with the publisher key (the same ~/.sui
   active key the faucet uses). These calls pay their own gas and do NOT go
   through Enoki — they're protocol-operator actions, not user actions. */
const ORACLE_ADMIN_CAP = "0x33adac6f64ae3ecb1af395de98f9a4f0708d1d97f4848a32dc428a7b9e651b87";
const KEEPER_CAP_ID = "0x3767fad45d82370652ccec28025f83545833ee7f2e1567042b7f5067a3ab1e3a";

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
  throw new Error("no oracle key in ~/.sui");
}

const client = () => serverSuiClient();

/** Everything the scenario chart needs, in one devInspect batch. */
export type OracleStatus = {
  mark: number;
  triggered: boolean;
  sigmaBps: number; // EWMA σ (0 if vol not armed)
  releaseProgress: number; // consecutive in-band prints toward unlatch
  rehypothecated: number; // institution principal in DeepBook (0 if no instId)
};

async function readStatus(c: SuiJsonRpcClient, instId?: string): Promise<OracleStatus> {
  const tx = new Transaction();
  tx.moveCall({ target: TARGET.oracle.price, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(SPCX.symbol)] });
  tx.moveCall({ target: TARGET.oracle.isTriggered, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(SPCX.symbol)] });
  tx.moveCall({ target: TARGET.oracle.volBps, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(SPCX.symbol)] });
  tx.moveCall({ target: TARGET.oracle.releaseProgress, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(SPCX.symbol)] });
  if (instId) {
    tx.moveCall({
      target: TARGET.institution.rehypothecatedOf,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(instId)],
    });
  }
  const r = await c.devInspectTransactionBlock({ sender: SHARED.riskOracle, transactionBlock: tx });
  const u64 = (i: number) => {
    const b = (r.results?.[i]?.returnValues?.[0]?.[0] ?? []) as number[];
    let v = 0n;
    for (let j = b.length - 1; j >= 0; j--) v = (v << 8n) + BigInt(b[j]);
    return v;
  };
  return {
    mark: Number(u64(0)) / 1e6,
    triggered: ((r.results?.[1]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1,
    sigmaBps: Number(u64(2)),
    releaseProgress: Number(u64(3)),
    rehypothecated: instId ? Number(u64(4)) / 1e6 : 0,
  };
}

/** Contracts among `otcIds` that are crankable right now: MM-breached, or
 *  carrying a pending margin call (stale or live). Returns their party ids. */
async function crankable(c: SuiJsonRpcClient, otcIds: string[]) {
  if (!otcIds.length) return [];
  const tx = new Transaction();
  for (const id of otcIds) {
    tx.moveCall({
      target: TARGET.otc.mmBreached,
      typeArguments: [DBUSDC_TYPE],
      arguments: [tx.object(id), tx.object(SHARED.riskOracle), tx.object(CLOCK)],
    });
    tx.moveCall({ target: TARGET.otc.marginCallDeadline, typeArguments: [DBUSDC_TYPE], arguments: [tx.object(id)] });
  }
  const [r, objs] = await Promise.all([
    c.devInspectTransactionBlock({ sender: SHARED.riskOracle, transactionBlock: tx }),
    c.multiGetObjects({ ids: otcIds, options: { showContent: true } }),
  ]);
  const out: { otcId: string; instLong: string; instShort: string }[] = [];
  otcIds.forEach((otcId, i) => {
    const breached = (r.results?.[2 * i]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
    const hasCall = ((r.results?.[2 * i + 1]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
    const f = (objs[i]?.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f || Number(f.status ?? "0") !== 0) return;
    if (breached || hasCall) out.push({ otcId, instLong: f.inst_long!, instShort: f.inst_short! });
  });
  return out;
}

/** settle_on_breach one contract (permissionless, keeper-signed). Returns the
 *  post-crank margin-call deadline (null if it paid/cleared) + terminal status. */
async function crank(c: SuiJsonRpcClient, kp: Ed25519Keypair, target: { otcId: string; instLong: string; instShort: string }) {
  const tx = new Transaction();
  tx.moveCall({
    target: TARGET.otc.settleOnBreach,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      tx.object(target.otcId),
      tx.object(target.instLong),
      tx.object(target.instShort),
      tx.object(SHARED.riskOracle),
      tx.object(SHARED.otcAllowlist),
      tx.object(CLOCK),
    ],
  });
  const res = await c.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  await c.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== "success") {
    return { otcId: target.otcId, ok: false as const, digest: res.digest, error: res.effects?.status.error };
  }
  // read back the contract's state
  const view = new Transaction();
  view.moveCall({ target: TARGET.otc.marginCallDeadline, typeArguments: [DBUSDC_TYPE], arguments: [view.object(target.otcId)] });
  const r = await c.devInspectTransactionBlock({ sender: SHARED.riskOracle, transactionBlock: view });
  const ob = (r.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[];
  let deadline: number | null = null;
  if (ob[0] === 1) {
    let v = 0n;
    for (let j = 8; j >= 1; j--) v = (v << 8n) + BigInt(ob[j]);
    deadline = Number(v);
  }
  const obj = await c.getObject({ id: target.otcId, options: { showContent: true } });
  const status = Number(((obj.data?.content as { fields?: Record<string, string> } | undefined)?.fields?.status) ?? "0");
  return { otcId: target.otcId, ok: true as const, digest: res.digest, deadline, status };
}

/** Permissionless risk recall for `instId`; returns the recall digest. */
async function recallOnTrigger(c: SuiJsonRpcClient, kp: Ed25519Keypair, instId: string) {
  const recall = new Transaction();
  recall.moveCall({
    target: TARGET.rehypo.recallOnTrigger,
    typeArguments: [DBUSDC_TYPE],
    arguments: [
      recall.object(instId),
      recall.object(DEEPBOOK.dbusdcMarginPool),
      recall.object(DEEPBOOK.marginRegistry),
      recall.object(SHARED.riskOracle),
      recall.pure.string(SPCX.symbol),
      recall.object(CLOCK),
    ],
  });
  const rr = await c.signAndExecuteTransaction({ signer: kp, transaction: recall, options: { showEffects: true } });
  await c.waitForTransaction({ digest: rr.digest });
  return { ok: rr.effects?.status.status === "success", digest: rr.digest };
}

function pushCall(tx: Transaction, price1e6: bigint) {
  // v2 = v1 + EWMA update; identical for feeds without vol state, so all
  // pushes route through it unconditionally.
  tx.moveCall({
    target: TARGET.oracle.pushPriceV2,
    arguments: [tx.object(SHARED.riskOracle), tx.object(KEEPER_CAP_ID), tx.pure.string(SPCX.symbol), tx.pure.u64(price1e6), tx.object(CLOCK)],
  });
}

function enableVolCall(tx: Transaction) {
  tx.moveCall({
    target: TARGET.oracle.enableVol,
    arguments: [
      tx.object(SHARED.riskOracle),
      tx.object(ORACLE_ADMIN_CAP),
      tx.pure.string(SPCX.symbol),
      tx.pure.u64(BigInt(SPCX_VOL.seedSigmaBps)),
      tx.pure.u64(BigInt(SPCX_VOL.lambdaBps)),
      tx.pure.u64(BigInt(SPCX_VOL.zLatchX100)),
      tx.pure.u64(BigInt(SPCX_VOL.sigmaCeilBps)),
      tx.pure.u64(BigInt(SPCX_VOL.thetaRelBps)),
      tx.pure.u64(BigInt(SPCX_VOL.releaseNeeded)),
    ],
  });
}

export async function POST(request: Request) {
  try {
    const { action, price, instId, otcIds, autoRecall } = await request.json();
    const c = client();
    const kp = keypair();

    if (action === "status") {
      return Response.json(await readStatus(c, typeof instId === "string" ? instId : undefined));
    }

    /* One scenario tick: keeper pushes the mark through the EWMA layer, then a
       same-node status read. On a latch:
        - with `otcIds` (drill armed): crank the breached contracts FIRST —
          with the desk's funds still out at venues they cannot pay, so the
          cranks record MARGIN CALLS (the cross-margin due-process beat). The
          recall is then the client's next move (`cure`), or the desk lets the
          calls age to liquidation.
        - without `otcIds` and while collateral is out: fire the permissionless
          recall immediately (the simple auto-deleverage beat), unless
          `autoRecall === false`. */
    if (action === "tick") {
      const p = BigInt(Math.round(Number(price) * 1e6));
      if (p <= 0n) return Response.json({ error: "bad price" }, { status: 400 });
      const push = new Transaction();
      pushCall(push, p);
      const pr = await c.signAndExecuteTransaction({ signer: kp, transaction: push, options: { showEffects: true } });
      await c.waitForTransaction({ digest: pr.digest });
      if (pr.effects?.status.status !== "success") {
        return Response.json({ error: "push failed" }, { status: 502 });
      }

      const inst = typeof instId === "string" ? instId : undefined;
      const drill: string[] = Array.isArray(otcIds) ? otcIds.filter((x) => typeof x === "string") : [];
      let status = await readStatus(c, inst);
      let recalled = false;
      let recalledAmount = 0;
      let recallDigest: string | undefined;
      const marginCalls: { otcId: string; deadline: number | null; status: number }[] = [];

      if (status.triggered && drill.length) {
        // teeth first: crank every breached contract while liquidity is out
        const targets = await crankable(c, drill);
        for (const t of targets) {
          const r = await crank(c, kp, t);
          if (r.ok) marginCalls.push({ otcId: r.otcId, deadline: r.deadline ?? null, status: r.status ?? 0 });
        }
      } else if (status.triggered && inst && status.rehypothecated > 0 && autoRecall !== false) {
        const before = status.rehypothecated;
        const r = await recallOnTrigger(c, kp, inst);
        if (r.ok) {
          recallDigest = r.digest;
          status = await readStatus(c, inst);
          recalled = true;
          recalledAmount = before - status.rehypothecated;
        }
      }
      return Response.json({ ...status, pushDigest: pr.digest, recalled, recalledAmount, recallDigest, marginCalls });
    }

    /* The cure: permissionless recall brings the desk's collateral home, then
       the same breach crank runs again — this time the desk CAN pay, so the
       calls clear and the positions survive (pay-and-survive grace). */
    if (action === "cure") {
      if (typeof instId !== "string") return Response.json({ error: "missing instId" }, { status: 400 });
      const drill: string[] = Array.isArray(otcIds) ? otcIds.filter((x) => typeof x === "string") : [];
      let status = await readStatus(c, instId);
      let recalled = false;
      let recalledAmount = 0;
      let recallDigest: string | undefined;
      if (status.triggered && status.rehypothecated > 0) {
        const before = status.rehypothecated;
        const r = await recallOnTrigger(c, kp, instId);
        if (r.ok) {
          recallDigest = r.digest;
          status = await readStatus(c, instId);
          recalled = true;
          recalledAmount = before - status.rehypothecated;
        }
      }
      const cured: { otcId: string; deadline: number | null; status: number }[] = [];
      const targets = await crankable(c, drill);
      for (const t of targets) {
        const r = await crank(c, kp, t);
        if (r.ok) cured.push({ otcId: r.otcId, deadline: r.deadline ?? null, status: r.status ?? 0 });
      }
      return Response.json({ ...status, recalled, recalledAmount, recallDigest, cured });
    }

    /* Manual crank of one contract (the liquidation encore path). */
    if (action === "crank") {
      if (typeof otcIds?.[0] !== "string") return Response.json({ error: "missing otcIds" }, { status: 400 });
      const targets = await crankable(c, [otcIds[0]]);
      if (!targets.length) return Response.json({ error: "contract is healthy — nothing to crank" }, { status: 409 });
      const r = await crank(c, kp, targets[0]);
      if (!r.ok) return Response.json({ error: r.error ?? "crank failed" }, { status: 502 });
      return Response.json({ otcId: r.otcId, deadline: r.deadline, status: r.status, digest: r.digest });
    }

    // Spike + permissionless recall in one server-side sequence (manual mode).
    if (action === "spike") {
      if (typeof instId !== "string") return Response.json({ error: "missing instId" }, { status: 400 });
      const p = BigInt(Math.round(Number(price ?? SPCX.spikeMark) * 1e6));
      const push = new Transaction();
      pushCall(push, p);
      const pr = await c.signAndExecuteTransaction({ signer: kp, transaction: push, options: { showEffects: true } });
      await c.waitForTransaction({ digest: pr.digest });
      if (pr.effects?.status.status !== "success") return Response.json({ error: "push failed" }, { status: 502 });

      const status = await readStatus(c, instId);
      if (!status.triggered) return Response.json({ ...status, recalled: false });

      const r = await recallOnTrigger(c, kp, instId);
      const after = await readStatus(c, instId);
      return Response.json({ ...after, recalled: r.ok, recallDigest: r.digest });
    }

    const tx = new Transaction();
    if (action === "push") {
      const p = BigInt(Math.round(Number(price ?? SPCX.spikeMark) * 1e6));
      pushCall(tx, p);
    } else if (action === "clear") {
      tx.moveCall({
        target: TARGET.oracle.clearTrigger,
        arguments: [tx.object(SHARED.riskOracle), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SPCX.symbol)],
      });
    } else if (action === "reset") {
      // clean stage for a fresh run: back to the nominal mark, untriggered,
      // EWMA re-seeded (disable, push, clear, enable — one atomic tx).
      const st = await readStatus(c);
      if (st.sigmaBps > 0) {
        tx.moveCall({
          target: TARGET.oracle.disableVol,
          arguments: [tx.object(SHARED.riskOracle), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SPCX.symbol)],
        });
      }
      pushCall(tx, BigInt(SPCX.initialMark * 1e6));
      tx.moveCall({
        target: TARGET.oracle.clearTrigger,
        arguments: [tx.object(SHARED.riskOracle), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SPCX.symbol)],
      });
      enableVolCall(tx);
    } else {
      return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
    }

    const res = await c.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
    await c.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status !== "success") {
      return Response.json({ error: JSON.stringify(res.effects?.status) }, { status: 502 });
    }
    return Response.json({ digest: res.digest, ...(await readStatus(c)) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
