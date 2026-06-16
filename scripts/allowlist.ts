/**
 * Allowlist the OTC + RFQ witnesses on the deployed OtcAllowlist (ProtocolCap).
 * Computes the exact type-name strings on-chain (via the otc_forward views) and
 * pipes them straight into allow_otc_witness — no string-format guessing.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const PKG = '0x7106aeb00de8f07c4f5c28e1fc7b13b03e42e474e6221db81e81b09ca80b561e';
const ALLOWLIST = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const PROTOCOL_CAP = '0x0b226a0531f0b4436b0c07b4cffaa45a8da64d4e04c8f390a86d950739d03eec';

function keypair(): Ed25519Keypair {
  const cfg = join(homedir(), '.sui', 'sui_config');
  const addr =
    process.env.SUI_ADDRESS ??
    readFileSync(join(cfg, 'client.yaml'), 'utf8').match(/active_address:\s*"?(0x[0-9a-fA-F]+)"?/)?.[1];
  for (const b64 of JSON.parse(readFileSync(join(cfg, 'sui.keystore'), 'utf8')) as string[]) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes[0] !== 0) continue;
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.toSuiAddress() === addr) return kp;
  }
  throw new Error('no key for ' + addr);
}

async function main() {
  const kp = keypair();
  const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet') });

  const tx = new Transaction();
  const allow = tx.object(ALLOWLIST);
  const cap = tx.object(PROTOCOL_CAP);
  for (const fn of ['otc_witness_name', 'rfq_witness_name']) {
    const name = tx.moveCall({ target: `${PKG}::otc_forward::${fn}` });
    tx.moveCall({ target: `${PKG}::protocol::allow_otc_witness`, arguments: [allow, cap, name] });
  }

  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') {
    throw new Error('allowlist failed: ' + JSON.stringify(res.effects?.status));
  }
  console.log('✓ allowlisted OtcWitness + RfqWitness  ', res.digest);
  for (const e of res.events ?? []) {
    if ((e.type ?? '').includes('OtcWitnessAllowed')) console.log('  ', (e.parsedJson as any)?.witness);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
