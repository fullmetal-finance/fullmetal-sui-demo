/**
 * Upgrade the deployed fullmetal package via the SDK (the local `sui client
 * upgrade` panics because testnet's protocol version is newer than the CLI
 * binary; the SDK talks to the fullnode directly and is unaffected).
 *
 * Prereq: `sui move build --dump-bytecode-as-base64 > /tmp/dump.json` in contracts/.
 * Usage:  npx tsx upgrade.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';

import { TESTNET_JSONRPC_URL } from './rpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const UPGRADE_CAP = '0xbe6518c77007f7fb3940faed2b4b3bf5ec8a6a7fcc653f66eeee548614149fe2';
const COMPATIBLE_POLICY = 0;

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
  const { modules, dependencies, digest } = JSON.parse(readFileSync('/tmp/dump.json', 'utf8'));
  const kp = keypair();
  const client = new SuiJsonRpcClient({ url: TESTNET_JSONRPC_URL });

  // The upgrade command must reference the CURRENT package the UpgradeCap points
  // at (it advances on every commit), so read it live rather than hardcoding.
  const capObj = await client.getObject({ id: UPGRADE_CAP, options: { showContent: true } });
  const currentPkg = (capObj.data?.content as any)?.fields?.package as string;
  if (!currentPkg) throw new Error('could not read UpgradeCap.package');
  console.log('upgrading from package:', currentPkg);

  const tx = new Transaction();
  const cap = tx.object(UPGRADE_CAP);
  const ticket = tx.moveCall({
    target: '0x2::package::authorize_upgrade',
    arguments: [cap, tx.pure.u8(COMPATIBLE_POLICY), tx.pure.vector('u8', digest)],
  });
  const receipt = tx.upgrade({ modules, dependencies, package: currentPkg, ticket });
  tx.moveCall({ target: '0x2::package::commit_upgrade', arguments: [cap, receipt] });

  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') {
    throw new Error('upgrade failed: ' + JSON.stringify(res.effects?.status) + '\n  ' + res.digest);
  }
  const pub = (res.objectChanges ?? []).find((c: any) => c.type === 'published');
  console.log('✓ upgrade tx:', res.digest);
  console.log('NEW PACKAGE ID:', (pub as any)?.packageId);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
