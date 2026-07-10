/**
 * Accept a DirectOffer on behalf of an ops-controlled maker desk (the demo's
 * "counterparty desk accepts your proposal" beat, and the setup for the
 * margin-call drill: propose a 1-SPCX long to `cumberland` from the app, then
 * run this with the offer id).
 *
 * Funds the maker desk with the offer's IM (+ buffer for VM) first, then
 * `accept_direct` — signed by the ops key that holds the maker's caps.
 *
 * Usage: npx tsx accept-direct.ts <offerId>
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

import { TESTNET_JSONRPC_URL } from './rpc';

const PKG = '0xf8b57f09dfe5e59fcc176110c8f15cf96b27f6f23be8a4db959529d896635a4a';
const ORIGINAL_PKG = '0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf';
const ALLOWLIST = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const CLOCK = '0x6';

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

const client = new SuiJsonRpcClient({ url: TESTNET_JSONRPC_URL });
const kp = keypair();
const me = kp.toSuiAddress();

async function capsFor(instId: string): Promise<{ admin: string; trader: string }> {
  const out = { admin: '', trader: '' };
  for (const type of ['AdminCap', 'TraderCap']) {
    let cursor: string | null | undefined = null;
    do {
      const page = await client.getOwnedObjects({
        owner: me,
        filter: { StructType: `${ORIGINAL_PKG}::institution::${type}` },
        options: { showContent: true },
        cursor: cursor ?? undefined,
      });
      for (const o of page.data) {
        const iid = (o.data?.content as { fields?: { institution_id?: string } } | undefined)?.fields?.institution_id;
        if (iid === instId) {
          if (type === 'AdminCap') out.admin = o.data!.objectId;
          else out.trader = o.data!.objectId;
        }
      }
      cursor = page.hasNextPage ? page.nextCursor : null;
    } while (cursor);
  }
  if (!out.admin || !out.trader) throw new Error(`ops key holds no Admin/Trader caps for ${instId}`);
  return out;
}

async function main() {
  const offerId = process.argv[2];
  if (!offerId?.startsWith('0x')) throw new Error('usage: npx tsx accept-direct.ts <offerId>');

  const o = await client.getObject({ id: offerId, options: { showContent: true } });
  const f = (o.data?.content as { fields?: Record<string, string> } | undefined)?.fields;
  if (!f) throw new Error('offer not found');
  if (Number(f.status) !== 0) throw new Error(`offer status ${f.status} — not live`);
  const counterparty = f.counterparty_inst!;
  const proposer = f.proposer_inst!;
  const im = BigInt(f.im_each ?? '0');
  console.log(`offer ${offerId.slice(0, 10)}… → counterparty desk ${counterparty.slice(0, 10)}…, IM ${Number(im) / 1e6} DBUSDC`);

  const caps = await capsFor(counterparty);

  // fund IM + VM buffer, then accept — one PTB
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG}::institution::deposit_treasury`,
    typeArguments: [DBUSDC],
    arguments: [tx.object(counterparty), tx.object(caps.admin), coinWithBalance({ type: DBUSDC, balance: im + 5_000_000n })],
  });
  tx.moveCall({
    target: `${PKG}::direct::accept_direct`,
    typeArguments: [DBUSDC],
    arguments: [
      tx.object(offerId),
      tx.object(counterparty),
      tx.object(caps.trader),
      tx.object(proposer),
      tx.object(ALLOWLIST),
      tx.object(CLOCK),
    ],
  });
  const res = await client.signAndExecuteTransaction({ signer: kp, transaction: tx, options: { showEffects: true, showObjectChanges: true } });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') throw new Error('accept failed: ' + JSON.stringify(res.effects?.status));
  const otc = (res.objectChanges ?? []).find(
    (c) => (c as { type?: string }).type === 'created' && ((c as { objectType?: string }).objectType ?? '').includes('::otc_forward::OtcForward<'),
  ) as { objectId?: string } | undefined;
  console.log(`✓ accepted — OtcForward ${otc?.objectId}`);
  console.log(`  tx ${res.digest}`);
  console.log('\nNOTE: add this contract to the app blotter by accepting from the desk that PROPOSED it');
  console.log('(the proposer’s UI records the offer; the OTC id lands in its blotter on next refresh).');
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
