/**
 * Live two-institution RFQ on testnet: Goldwoman Socks requests a forward,
 * Cumberland quotes it firm, Goldwoman accepts — opening the bilateral
 * OtcForward with a single signer per step. Proves the async-open + firm-quote
 * design end-to-end with real DBUSDC.
 *
 * One wallet plays both desks (holds both institutions' caps); the contract
 * checks caps, not signers, so this faithfully exercises the on-chain logic.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

const PKG = '0x7106aeb00de8f07c4f5c28e1fc7b13b03e42e474e6221db81e81b09ca80b561e';
const HANDLE_REGISTRY = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const ALLOWLIST = '0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a';
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const CLOCK = '0x6';

const FUND = 100_000_000n; // 100 DBUSDC each
const IM = 20_000_000n; // 20 DBUSDC IM per side

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
  throw new Error('no key');
}

const kp = keypair();
const me = kp.toSuiAddress();
const client = new SuiJsonRpcClient({ url: getJsonRpcFullnodeUrl('testnet') });

async function run(label: string, build: (tx: Transaction) => void) {
  const tx = new Transaction();
  build(tx);
  const res = await client.signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true },
  });
  await client.waitForTransaction({ digest: res.digest });
  if (res.effects?.status.status !== 'success') {
    throw new Error(`${label} FAILED: ${JSON.stringify(res.effects?.status)}\n  ${res.digest}`);
  }
  console.log(`✓ ${label}`);
  return res;
}

function created(res: any, t: string): string {
  const c = (res.objectChanges ?? []).find((o: any) => o.type === 'created' && (o.objectType ?? '').includes(t));
  if (!c) throw new Error('no created ' + t);
  return c.objectId;
}

async function reserved(inst: string): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::institution::reserved_of`, typeArguments: [DBUSDC], arguments: [tx.object(inst)] });
  const r = await client.devInspectTransactionBlock({ sender: me, transactionBlock: tx });
  const b = r.results?.[0]?.returnValues?.[0]?.[0] ?? [];
  let v = 0n;
  for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) + BigInt(b[i]);
  return (Number(v) / 1e6).toString();
}

async function makeInst(name: string, handle: string): Promise<{ inst: string; admin: string; trader: string }> {
  const r1 = await run(`create ${name}`, (tx) => {
    const cap = tx.moveCall({
      target: `${PKG}::institution::create_institution`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(HANDLE_REGISTRY), tx.pure.string(handle)],
    });
    tx.transferObjects([cap], me);
  });
  const inst = created(r1, '::institution::Institution<');
  const admin = created(r1, '::institution::AdminCap');
  const r2 = await run(`fund ${name} 100 DBUSDC + grant trader`, (tx) => {
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(admin), coinWithBalance({ type: DBUSDC, balance: FUND })],
    });
    const t = tx.moveCall({
      target: `${PKG}::institution::grant_trader`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(admin), tx.pure.address(me), tx.pure.u64(1_000_000_000_000n)],
    });
    tx.transferObjects([t], me);
  });
  const trader = created(r2, '::institution::TraderCap');
  console.log(`  ${name}: inst=${inst.slice(0, 10)}… trader=${trader.slice(0, 10)}…`);
  return { inst, admin, trader };
}

async function main() {
  console.log(`signer: ${me}\npackage: ${PKG}\n`);
  const gold = await makeInst('Goldwoman Socks', 'goldwomansocks');
  const cumb = await makeInst('Cumberland', 'cumberland');
  console.log();

  // Goldwoman (requester, long) opens an RFQ
  const r1 = await run('Goldwoman opens RFQ (long 50 SUI fwd)', (tx) => {
    tx.moveCall({
      target: `${PKG}::rfq::open_rfq`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(gold.inst),
        tx.object(gold.trader),
        tx.pure.vector('address', []), // broadcast (Cumberland is the only other desk)
        tx.pure.u8(0), // requester long
        tx.pure.string('SUI'),
        tx.pure.u64(50_000_000n), // notional 50 units
        tx.pure.u64(IM),
        tx.pure.u64(0n), // funding bps
        tx.pure.bool(false),
        tx.pure.u64(0n), // settle interval
        tx.pure.u64(0n), // contract expiry
        tx.pure.u64(1_900_000n), // min price
        tx.pure.u64(2_100_000n), // max price
        tx.pure.u64(3_600_000n), // rfq ttl
        tx.object(CLOCK),
      ],
    });
  });
  const rfqId = created(r1, '::rfq::Rfq<');

  // Cumberland (maker) submits a firm quote @ $2.00 -> reserves its IM
  const r2 = await run('Cumberland quotes firm @ $2.00', (tx) => {
    tx.moveCall({
      target: `${PKG}::rfq::submit_quote`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(rfqId),
        tx.object(cumb.inst),
        tx.object(cumb.trader),
        tx.object(ALLOWLIST),
        tx.pure.u64(2_000_000n),
        tx.pure.u64(1_800_000n), // quote ttl
        tx.object(CLOCK),
      ],
    });
  });
  const quoteId = created(r2, '::rfq::Quote<');
  console.log(`  Cumberland reserved after quote: ${await reserved(cumb.inst)} DBUSDC`);

  // Goldwoman accepts -> opens the OtcForward atomically (single signer)
  const r3 = await run('Goldwoman accepts -> contract opens', (tx) => {
    tx.moveCall({
      target: `${PKG}::rfq::accept_quote`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(rfqId),
        tx.object(quoteId),
        tx.object(gold.inst),
        tx.object(gold.trader),
        tx.object(cumb.inst),
        tx.object(ALLOWLIST),
        tx.object(CLOCK),
      ],
    });
  });
  const otcId = created(r3, '::otc_forward::OtcForward<');

  console.log(`\n=== result ===`);
  console.log(`  Goldwoman reserved IM: ${await reserved(gold.inst)} DBUSDC`);
  console.log(`  Cumberland reserved IM: ${await reserved(cumb.inst)} DBUSDC`);
  console.log(`  OtcForward: https://suiscan.xyz/testnet/object/${otcId}`);
  console.log(`  RFQ:        https://suiscan.xyz/testnet/object/${rfqId}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
