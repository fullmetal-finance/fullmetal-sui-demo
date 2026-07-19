import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, DEEPBOOK, SHARED, SPCX, SPCX_VOL, TARGET } from "@/lib/fullmetal";
import { opsTx } from "@/lib/keeper-queue";
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

/** Contracts among `otcIds` that are crankable right now: ACTIVE, not past
 *  expiry (`settle_on_breach` aborts on expired contracts — code 78, use
 *  `close` instead), and MM-breached or carrying a pending margin call. */
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
  const now = Date.now();
  const out: { otcId: string; instLong: string; instShort: string }[] = [];
  otcIds.forEach((otcId, i) => {
    const breached = (r.results?.[2 * i]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
    const hasCall = ((r.results?.[2 * i + 1]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
    const f = (objs[i]?.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f || Number(f.status ?? "0") !== 0) return;
    const expiry = Number(f.expiry_ms ?? "0");
    if (expiry > 0 && now >= expiry) return; // expired → only `close` may settle it
    if (breached || hasCall) out.push({ otcId, instLong: f.inst_long!, instShort: f.inst_short! });
  });
  return out;
}

/** Human-readable reasons for the two crank aborts a demo can hit. */
function crankAbortReason(err?: string): string | undefined {
  if (!err) return undefined;
  if (err.includes("abort code: 78")) return "contract is past expiry — settle it via close; the breach crank no longer applies";
  if (err.includes("abort code: 77")) return "margin-call cure window still running — crank again after the countdown";
  if (err.includes("abort code: 73")) return "position is healthy — nothing to crank";
  return err;
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
  // A crank that WOULD abort (e.g. code 77 while the cure window runs) fails at
  // the SDK's dry-run/gas-estimation step and THROWS — it never reaches effects.
  // A failed crank is a normal outcome for the tick/cure flows, so catch it and
  // return ok:false instead of 500ing the whole action (which killed the
  // client's market loop → frozen chart, no release, no redeposit).
  let res;
  try {
    res = await c.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true } });
  } catch (e) {
    return {
      otcId: target.otcId,
      ok: false as const,
      digest: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
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

/** A margin call is a dynamic field on the CONTRACT — resetting the ORACLE
 *  (mark back to nominal, trigger cleared) does not touch it. A stale call is a
 *  loaded gun: it stays pending through calm markets (cranks only run while
 *  triggered, so the healthy-path auto-clear never fires), and the NEXT breach —
 *  by either side — liquidates instantly against the old, already-aged window
 *  instead of getting its own cure period (observed live 2026-07-12: spike
 *  called the short, reset, crash 3 min later liquidated the LONG in 4s).
 *  So on reset, crank each healthy contract that still carries a call:
 *  `settle_on_breach`'s healthy path clears the call and moves no funds.
 *  Contracts still breached at the reset mark are left alone (cranking those
 *  could liquidate) and reported back as `stillCalled`. */
async function clearStaleCalls(c: SuiJsonRpcClient, kp: Ed25519Keypair, otcIds: string[]) {
  const cleared: string[] = [];
  const stillCalled: string[] = [];
  if (!otcIds.length) return { cleared, stillCalled };
  const view = new Transaction();
  for (const id of otcIds) {
    view.moveCall({
      target: TARGET.otc.mmBreached,
      typeArguments: [DBUSDC_TYPE],
      arguments: [view.object(id), view.object(SHARED.riskOracle), view.object(CLOCK)],
    });
    view.moveCall({ target: TARGET.otc.marginCallDeadline, typeArguments: [DBUSDC_TYPE], arguments: [view.object(id)] });
  }
  const [r, objs] = await Promise.all([
    c.devInspectTransactionBlock({ sender: SHARED.riskOracle, transactionBlock: view }),
    c.multiGetObjects({ ids: otcIds, options: { showContent: true } }),
  ]);
  const now = Date.now();
  for (let i = 0; i < otcIds.length; i++) {
    const breached = (r.results?.[2 * i]?.returnValues?.[0]?.[0] as number[] | undefined)?.[0] === 1;
    const hasCall = ((r.results?.[2 * i + 1]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
    const f = (objs[i]?.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
    if (!f || Number(f.status ?? "0") !== 0 || !hasCall) continue;
    const expiry = Number(f.expiry_ms ?? "0");
    if (expiry > 0 && now >= expiry) continue; // expired → crank aborts 78; close() handles these
    if (breached) {
      stillCalled.push(otcIds[i]); // live call on a live breach — not ours to defuse
      continue;
    }
    const crankTx = new Transaction();
    crankTx.moveCall({
      target: TARGET.otc.settleOnBreach,
      typeArguments: [DBUSDC_TYPE],
      arguments: [
        crankTx.object(otcIds[i]),
        crankTx.object(f.inst_long!),
        crankTx.object(f.inst_short!),
        crankTx.object(SHARED.riskOracle),
        crankTx.object(SHARED.otcAllowlist),
        crankTx.object(CLOCK),
      ],
    });
    const res = await c.signAndExecuteTransaction({ signer: kp, transaction: crankTx, options: { showEffects: true } });
    await c.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status === "success") cleared.push(otcIds[i]);
    else stillCalled.push(otcIds[i]);
  }
  return { cleared, stillCalled };
}

/** Permissionless risk recall for `instId`; returns the recall digest.
 *  Same dry-run-throw hazard as `crank` (e.g. abort 63 if the trigger released
 *  between the status read and the tx) — a failed recall must not 500 the tick. */
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
  let rr;
  try {
    rr = await c.signAndExecuteTransaction({ signer: kp, transaction: recall, options: { showEffects: true } });
  } catch {
    return { ok: false, digest: "" };
  }
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

    // Every remaining action WRITES with the ops key. Serialize them — two
    // concurrent keeper txs equivocate on the gas coin and get rejected by
    // >1/3 of validators (see lib/keeper-queue.ts).
    return await opsTx(async () => {

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
      }
      // No margin calls landed (no crankable contracts, or cranks paid outright)
      // → the plain auto-deleverage path must still fire: recall on the latch.
      if (
        status.triggered && inst && status.rehypothecated > 0 && autoRecall !== false &&
        marginCalls.filter((m) => m.deadline != null).length === 0
      ) {
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
      if (!targets.length) {
        return Response.json({ error: "not crankable — position is healthy, terminal, or past expiry" }, { status: 409 });
      }
      const r = await crank(c, kp, targets[0]);
      if (!r.ok) return Response.json({ error: crankAbortReason(r.error) ?? "crank failed" }, { status: 502 });
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
    // reset also defuses stale margin calls on the armed contracts (see helper)
    if (action === "reset") {
      const drill: string[] = Array.isArray(otcIds) ? otcIds.filter((x) => typeof x === "string") : [];
      const sweep = await clearStaleCalls(c, kp, drill);
      return Response.json({
        digest: res.digest,
        ...(await readStatus(c)),
        clearedCalls: sweep.cleared,
        stillCalled: sweep.stillCalled,
      });
    }
    return Response.json({ digest: res.digest, ...(await readStatus(c)) });
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
