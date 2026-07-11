import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";

import { serverSuiClient } from "@/lib/server-sui";

export const runtime = "nodejs";

/* SUI gas top-up for the SELF-PAID fallback path — used only while Enoki's
   sponsorship rails are failing (client falls back after the full-cycle retry
   in lib/sponsored.ts gives up). Sends a sliver of SUI from the ops wallet so
   the connected zkLogin address can pay its own gas. SERVER ONLY. */

const MIN_BALANCE = 50_000_000n; // 0.05 SUI — plenty for several PTBs
const TOPUP = 300_000_000n; // 0.3 SUI per top-up
const COOLDOWN_MS = 120_000; // one top-up per address per window
const lastTopup = new Map<string, number>();

/* Same key source as the faucet: FAUCET_SECRET_KEY when deployed, else the
   active ~/.sui key (the ops / publisher wallet) for the local demo. */
function opsKeypair(): Ed25519Keypair {
  const fromEnv = process.env.FAUCET_SECRET_KEY;
  if (fromEnv) return Ed25519Keypair.fromSecretKey(fromEnv);

  const cfg = join(homedir(), ".sui", "sui_config");
  const addr =
    process.env.SUI_ADDRESS ??
    readFileSync(join(cfg, "client.yaml"), "utf8").match(/active_address:\s*"?(0x[0-9a-fA-F]+)"?/)?.[1];
  for (const b64 of JSON.parse(readFileSync(join(cfg, "sui.keystore"), "utf8")) as string[]) {
    const bytes = Buffer.from(b64, "base64");
    if (bytes[0] !== 0) continue; // ed25519 scheme flag
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error("no ops key found in ~/.sui");
}

export async function POST(request: Request) {
  try {
    const { address } = await request.json();
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
      return Response.json({ error: "bad address" }, { status: 400 });
    }

    const client = serverSuiClient();
    const { totalBalance } = await client.getBalance({ owner: address });
    if (BigInt(totalBalance) >= MIN_BALANCE) {
      return Response.json({ funded: false, balance: totalBalance });
    }

    const last = lastTopup.get(address) ?? 0;
    if (Date.now() - last < COOLDOWN_MS) {
      return Response.json({ error: "gas top-up cooling down — retry shortly" }, { status: 429 });
    }
    lastTopup.set(address, Date.now());

    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [TOPUP]);
    tx.transferObjects([coin], address);

    const res = await client.signAndExecuteTransaction({
      signer: opsKeypair(),
      transaction: tx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status !== "success") {
      lastTopup.delete(address); // failed send shouldn't burn the cooldown
      return Response.json({ error: JSON.stringify(res.effects?.status) }, { status: 502 });
    }
    return Response.json({ funded: true, digest: res.digest });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
