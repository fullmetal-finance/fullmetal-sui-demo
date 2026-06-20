import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction, coinWithBalance } from "@mysten/sui/transactions";

import { DBUSDC_TYPE } from "@/lib/fullmetal";

export const runtime = "nodejs";

const MAX_PER_REQUEST = 100; // DBUSDC cap per call

/* The mock fiat on-ramp's funded source. Local demo: read the active key from
   ~/.sui (the publisher / priceless-heliotrope key that holds DBUSDC). Deployed:
   set FAUCET_SECRET_KEY (a bech32 `suiprivkey…`). SERVER ONLY. */
function faucetKeypair(): Ed25519Keypair {
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
  throw new Error("no faucet key found in ~/.sui");
}

export async function POST(request: Request) {
  try {
    const { to, amount } = await request.json();
    if (typeof to !== "string" || !to.startsWith("0x")) {
      return Response.json({ error: "bad recipient address" }, { status: 400 });
    }
    const amt = Math.min(Math.max(Number(amount) || 50, 1), MAX_PER_REQUEST);
    const units = BigInt(Math.round(amt * 1e6));

    const kp = faucetKeypair();
    const client = new SuiJsonRpcClient({ network: "testnet", url: getJsonRpcFullnodeUrl("testnet") });

    const tx = new Transaction();
    tx.transferObjects([coinWithBalance({ type: DBUSDC_TYPE, balance: units })], to);

    const res = await client.signAndExecuteTransaction({
      signer: kp,
      transaction: tx,
      options: { showEffects: true, showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: res.digest });
    if (res.effects?.status.status !== "success") {
      return Response.json({ error: JSON.stringify(res.effects?.status) }, { status: 502 });
    }
    // the freshly-split DBUSDC coin now owned by `to` — return it so the deposit
    // can consume the exact coin (no client-side splitting / framework calls).
    const coin = (res.objectChanges ?? []).find((o) => {
      const x = o as { type?: string; objectType?: string; owner?: { AddressOwner?: string } };
      return (
        (x.type === "created" || x.type === "transferred") &&
        (x.objectType ?? "").includes("DBUSDC::DBUSDC>") &&
        x.owner?.AddressOwner === to
      );
    }) as { objectId?: string } | undefined;
    return Response.json({ digest: res.digest, amount: amt, coinId: coin?.objectId ?? null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
