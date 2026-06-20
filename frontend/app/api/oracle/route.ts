import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { CLOCK, DBUSDC_TYPE, DEEPBOOK, SHARED, SPCX, TARGET } from "@/lib/fullmetal";

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

const client = () =>
  new SuiJsonRpcClient({ network: "testnet", url: getJsonRpcFullnodeUrl("testnet") });

export async function POST(request: Request) {
  try {
    const { action, price, instId } = await request.json();
    const c = client();
    const kp = keypair();

    if (action === "status") {
      const r = await readStatus(c);
      return Response.json(r);
    }

    // Spike + permissionless recall in one server-side sequence — both txs run
    // sequentially against the SAME node, so the recall's gas dry-run can never
    // read a pre-spike snapshot (the cross-node race that broke the gasless path).
    if (action === "spike") {
      if (typeof instId !== "string") return Response.json({ error: "missing instId" }, { status: 400 });
      // push the operator's chosen mark; the feed latches the trigger itself if
      // the move exceeds its threshold.
      const p = BigInt(Math.round(Number(price ?? SPCX.spikeMark) * 1e6));
      const push = new Transaction();
      push.moveCall({
        target: TARGET.oracle.pushPrice,
        arguments: [push.object(SHARED.riskOracle), push.object(KEEPER_CAP_ID), push.pure.string(SPCX.symbol), push.pure.u64(p), push.object(CLOCK)],
      });
      const pr = await c.signAndExecuteTransaction({ signer: kp, transaction: push, options: { showEffects: true } });
      await c.waitForTransaction({ digest: pr.digest });
      if (pr.effects?.status.status !== "success") return Response.json({ error: "push failed" }, { status: 502 });

      // recall only if the push actually latched the trigger (same-node read, no race)
      const status = await readStatus(c);
      if (!status.triggered) return Response.json({ ...status, recalled: false });

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
      return Response.json({ ...status, recalled: rr.effects?.status.status === "success", recallDigest: rr.digest });
    }

    const tx = new Transaction();
    if (action === "push") {
      const p = BigInt(Math.round(Number(price ?? SPCX.spikeMark) * 1e6));
      tx.moveCall({
        target: TARGET.oracle.pushPrice,
        arguments: [tx.object(SHARED.riskOracle), tx.object(KEEPER_CAP_ID), tx.pure.string(SPCX.symbol), tx.pure.u64(p), tx.object(CLOCK)],
      });
    } else if (action === "clear") {
      tx.moveCall({
        target: TARGET.oracle.clearTrigger,
        arguments: [tx.object(SHARED.riskOracle), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SPCX.symbol)],
      });
    } else if (action === "reset") {
      // back to the nominal mark, untriggered (push may re-latch on a big move,
      // so clear in the same tx) — for re-recording a clean run.
      const p = BigInt(Math.round(SPCX.initialMark * 1e6));
      tx.moveCall({
        target: TARGET.oracle.pushPrice,
        arguments: [tx.object(SHARED.riskOracle), tx.object(KEEPER_CAP_ID), tx.pure.string(SPCX.symbol), tx.pure.u64(p), tx.object(CLOCK)],
      });
      tx.moveCall({
        target: TARGET.oracle.clearTrigger,
        arguments: [tx.object(SHARED.riskOracle), tx.object(ORACLE_ADMIN_CAP), tx.pure.string(SPCX.symbol)],
      });
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

async function readStatus(c: SuiJsonRpcClient): Promise<{ mark: number; triggered: boolean }> {
  const tx = new Transaction();
  tx.moveCall({ target: TARGET.oracle.price, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(SPCX.symbol)] });
  tx.moveCall({ target: TARGET.oracle.isTriggered, arguments: [tx.object(SHARED.riskOracle), tx.pure.string(SPCX.symbol)] });
  const r = await c.devInspectTransactionBlock({ sender: SHARED.riskOracle, transactionBlock: tx });
  const pb = (r.results?.[0]?.returnValues?.[0]?.[0] ?? []) as number[];
  let p = 0n;
  for (let i = pb.length - 1; i >= 0; i--) p = (p << 8n) + BigInt(pb[i]);
  const triggered = ((r.results?.[1]?.returnValues?.[0]?.[0] ?? []) as number[])[0] === 1;
  return { mark: Number(p) / 1e6, triggered };
}
