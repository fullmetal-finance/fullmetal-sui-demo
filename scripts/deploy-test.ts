/**
 * M-rehypo end-to-end on testnet: create an institution, deposit 50 DBUSDC,
 * rehypothecate it into DeepBook's margin pool, latch a volatility trigger on
 * the oracle, and recall the collateral — proving the risk-responsive
 * rehypothecation loop with real funds.
 *
 * Usage: npx tsx deploy-test.ts
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';

// ---- deployed package + objects (from publish) ----
const PKG = '0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf';
const HANDLE_REGISTRY = '0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8';
const RISK_ORACLE = '0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd';
const ORACLE_ADMIN_CAP = '0x33adac6f64ae3ecb1af395de98f9a4f0708d1d97f4848a32dc428a7b9e651b87';
// ---- external testnet DeepBook ----
const DBUSDC = '0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC';
const MARGIN_POOL = '0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d';
const MARGIN_REGISTRY = '0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75';
const CLOCK = '0x6';

const SYMBOL = 'DEMO';
const FIFTY = 50_000_000n; // 50 DBUSDC (6dp)

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
  console.log(`✓ ${label}  ${res.digest}`);
  return res;
}

function created(res: any, typeIncludes: string): string {
  const c = (res.objectChanges ?? []).find(
    (o: any) => o.type === 'created' && (o.objectType ?? '').includes(typeIncludes),
  );
  if (!c) throw new Error('no created object matching ' + typeIncludes);
  return c.objectId;
}

async function instField(inst: string, fn: string): Promise<string> {
  // read a u64 view via devInspect
  const tx = new Transaction();
  tx.moveCall({ target: `${PKG}::institution::${fn}`, typeArguments: [DBUSDC], arguments: [tx.object(inst)] });
  const r = await client.devInspectTransactionBlock({ sender: me, transactionBlock: tx });
  const bytes = r.results?.[0]?.returnValues?.[0]?.[0] ?? [];
  // u64 little-endian
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) + BigInt(bytes[i]);
  return v.toString();
}

async function main() {
  console.log(`signer:  ${me}`);
  console.log(`package: ${PKG}\n`);

  // 1. create institution
  const r1 = await run('create_institution', (tx) => {
    const cap = tx.moveCall({
      target: `${PKG}::institution::create_institution`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(HANDLE_REGISTRY), tx.pure.string('fmdemo')],
    });
    tx.transferObjects([cap], me);
  });
  const inst = created(r1, '::institution::Institution<');
  const adminCap = created(r1, '::institution::AdminCap');
  console.log(`  institution: ${inst}`);
  console.log(`  adminCap:    ${adminCap}\n`);

  // 2. deposit 50 DBUSDC + rehypothecate into the margin pool (one PTB)
  await run('deposit 50 DBUSDC + rehypothecate', (tx) => {
    tx.moveCall({
      target: `${PKG}::institution::deposit_treasury`,
      typeArguments: [DBUSDC],
      arguments: [tx.object(inst), tx.object(adminCap), coinWithBalance({ type: DBUSDC, balance: FIFTY })],
    });
    tx.moveCall({
      target: `${PKG}::rehypo::rehypothecate`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(inst),
        tx.object(adminCap),
        tx.object(MARGIN_POOL),
        tx.object(MARGIN_REGISTRY),
        tx.pure.u64(FIFTY),
        tx.object(CLOCK),
      ],
    });
  });
  console.log(`  rehypothecated: ${await instField(inst, 'rehypothecated_of')} (6dp)`);
  console.log(`  liquid treasury: ${await instField(inst, 'total')} (6dp)\n`);

  // 3. oracle: register feed + keeper, then push a crash to latch the trigger
  const r3 = await run('register feed + mint keeper', (tx) => {
    tx.moveCall({
      target: `${PKG}::oracle::register_feed`,
      arguments: [
        tx.object(RISK_ORACLE),
        tx.object(ORACLE_ADMIN_CAP),
        tx.pure.string(SYMBOL),
        tx.pure.u64(100_000_000n), // $100.00
        tx.pure.u64(1_000n), // 10% jump threshold
        tx.object(CLOCK),
      ],
    });
    const keeper = tx.moveCall({
      target: `${PKG}::oracle::mint_keeper_cap`,
      arguments: [tx.object(ORACLE_ADMIN_CAP)],
    });
    tx.transferObjects([keeper], me);
  });
  const keeper = created(r3, '::oracle::KeeperCap');

  await run('push crash price (latch trigger)', (tx) => {
    tx.moveCall({
      target: `${PKG}::oracle::push_price`,
      arguments: [
        tx.object(RISK_ORACLE),
        tx.object(keeper),
        tx.pure.string(SYMBOL),
        tx.pure.u64(50_000_000n), // crash to $50.00 (-50%)
        tx.object(CLOCK),
      ],
    });
  });
  console.log();

  // 4. risk-responsive recall — permissionless, gated on the latched trigger
  await run('recall_on_trigger', (tx) => {
    tx.moveCall({
      target: `${PKG}::rehypo::recall_on_trigger`,
      typeArguments: [DBUSDC],
      arguments: [
        tx.object(inst),
        tx.object(MARGIN_POOL),
        tx.object(MARGIN_REGISTRY),
        tx.object(RISK_ORACLE),
        tx.pure.string(SYMBOL),
        tx.object(CLOCK),
      ],
    });
  });
  console.log(`  rehypothecated after recall: ${await instField(inst, 'rehypothecated_of')} (6dp)`);
  console.log(`  liquid treasury after recall: ${await instField(inst, 'total')} (6dp)`);
  console.log(`\nInstitution on Suiscan: https://suiscan.xyz/testnet/object/${inst}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
