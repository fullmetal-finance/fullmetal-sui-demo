/**
 * Navi rehypothecation integration — MAINNET (Navi is mainnet-only).
 *
 * Exercises the live Navi USDC pool the same way an Institution would
 * rehypothecate: create an AccountCap (the shared-object-holdable lender handle,
 * like DeepBook's SupplierCap), supply USDC under it, withdraw back to USDC.
 *
 * Key facts verified on live mainnet (2026-06-26):
 *  - Modern path is incentive_v3 (NOT v2): deposit takes BOTH IncentiveV2 + V3.
 *  - Native-USDC asset id = 10 (u8). Deposit reads cached reserve state, so it
 *    needs NO oracle arg. Withdraw DOES take the PriceOracle and enforces a 15s
 *    staleness window (push oracle) -> a real withdraw should prepend an oracle
 *    update; a devInspect read can pass on the keeper's cached price.
 *  - withdraw_with_account_cap_v2 returns Balance<USDC> (wrap via coin::from_balance).
 *  - create_account_cap returns AccountCap (key,store) -> a shared Institution
 *    object can hold it; we mint it inside the PTB so simulation needs no pre-cap.
 *
 * Modes (pure PTBs against the live pool — no Move package linking):
 *   npx tsx navi-rehypo.ts
 *       read-only: prints the live USDC pool state, proves reachability.
 *   SUI_SENDER=0x<addr> npx tsx navi-rehypo.ts
 *       DEV-INSPECT supply against mainnet (gas-free simulation, no funds moved).
 *       <addr> must hold a little native USDC on mainnet.
 *   The REAL run (sign + execute) is intentionally NOT wired here — gated.
 */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const RPC = getJsonRpcFullnodeUrl("mainnet");
const client = new SuiJsonRpcClient({ network: "mainnet", url: RPC });

// ---- Navi mainnet objects (verified live 2026-06-26) ----
// Navi upgrades often and its version guard (version::pre_check_version) aborts
// if you target an old package. The latest published-at is served by Navi's own
// API; we fetch it at runtime so this never goes stale, with a known-good fallback.
// PKG_ORIGINAL (0xd899cf7d…) is the original id — struct types stay keyed there.
const PKG_FALLBACK = "0x1e4a13a0494d5facdbe8473e74127b838c2d446ecec0ce262e2eddafa77259cb";
async function latestPkg(): Promise<string> {
  try {
    const d: any = await fetch("https://open-api.naviprotocol.io/api/package").then((r) => r.json());
    return d?.packageId ?? PKG_FALLBACK;
  } catch {
    return PKG_FALLBACK;
  }
}
let PKG = PKG_FALLBACK; // resolved in main() before any moveCall
const STORAGE = "0xbb4e2f4b6205c2e2a2db47aeb4f830796ec7c005f88537ee775986639bc442fe";
const PRICE_ORACLE = "0x1568865ed9a0b5ec414220e8f79b3d04c77acc82358f6e5ae4635687392ffbef";
const INCENTIVE_V2 = "0xf87a8acb8b81d14307894d12595541a73f19933f88e1326d5be349c7a6f7559c";
const INCENTIVE_V3 = "0x62982dad27fb10bb314b3384d5de8d2ac2d72ab2dbeae5d801dbdb9efa816c80";
const CLOCK = "0x6";
const SUI_SYSTEM = "0x5"; // SuiSystemState — withdraw_v2 only

const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const USDC_POOL = "0xa3582097b4c57630046c0c49a88bfc6b202a3ec0a9db5597c31765f7563755a8"; // Pool<USDC>
const ASSET_ID = 10; // u8 — native USDC reserve
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000000"); // 1 USDC (6dp)

const CREATE_CAP = () => `${PKG}::account::create_account_cap`;
const DEPOSIT = () => `${PKG}::incentive_v3::deposit_with_account_cap`;
const WITHDRAW = () => `${PKG}::incentive_v3::withdraw_with_account_cap_v2`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function readPool(): Promise<void> {
  const o = await client.getObject({ id: USDC_POOL, options: { showContent: true } });
  const f = (o.data?.content as any)?.fields ?? {};
  // Navi Pool fields vary by version; print what's present rather than assume.
  const fmt = (v: any) => (v == null ? "—" : (Number(v) / 1e6).toFixed(2));
  console.log(`Navi USDC pool ${USDC_POOL.slice(0, 12)}…  (asset id ${ASSET_ID})`);
  console.log(`  pool keys: ${Object.keys(f).join(", ")}`);
  if (f.balance != null) console.log(`  balance ≈ ${fmt(f.balance?.fields?.value ?? f.balance)} USDC`);
  if (f.treasury_balance != null) console.log(`  treasury ≈ ${fmt(f.treasury_balance)} USDC`);
}

// supply PTB: mint a fresh AccountCap, deposit AMOUNT under it, keep the cap.
function supplyTx(sender: string, usdcCoinId: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const cap = tx.moveCall({ target: CREATE_CAP() }); // -> AccountCap (an Institution would stash this)
  const [coin] = tx.splitCoins(tx.object(usdcCoinId), [AMOUNT]);
  tx.moveCall({
    target: DEPOSIT(),
    typeArguments: [USDC],
    arguments: [
      tx.object(CLOCK),
      tx.object(STORAGE),
      tx.object(USDC_POOL),
      tx.pure.u8(ASSET_ID),
      coin,
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
      cap,
    ],
  });
  tx.transferObjects([cap], sender);
  return tx;
}

// withdraw path for reference (cap held by the supplier; real run must prepend an
// oracle price update for USDC to stay inside Navi's 15s freshness window).
export function withdrawTx(sender: string, capId: string, amount = AMOUNT): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const bal = tx.moveCall({
    target: WITHDRAW(),
    typeArguments: [USDC],
    arguments: [
      tx.object(CLOCK),
      tx.object(PRICE_ORACLE),
      tx.object(STORAGE),
      tx.object(USDC_POOL),
      tx.pure.u8(ASSET_ID),
      tx.pure.u64(amount),
      tx.object(INCENTIVE_V2),
      tx.object(INCENTIVE_V3),
      tx.object(capId),
      tx.object(SUI_SYSTEM),
    ],
  });
  const usdc = tx.moveCall({ target: "0x2::coin::from_balance", typeArguments: [USDC], arguments: [bal] });
  tx.transferObjects([usdc], sender);
  return tx;
}

async function main() {
  console.log("— Navi mainnet rehypothecation (read + dry-run) —\n");
  PKG = await latestPkg();
  console.log(`Navi current package: ${PKG.slice(0, 14)}…`);
  await readPool();

  const SENDER = process.env.SUI_SENDER;
  if (!SENDER) {
    console.log("\nReachable ✓. To DEV-INSPECT supply (no funds moved):");
    console.log("  SUI_SENDER=<mainnet addr holding ~1 USDC> npx tsx navi-rehypo.ts");
    return;
  }
  // devInspect needs NO gas/SUI — pure simulation. Fetch a USDC coin via raw RPC.
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getCoins", params: [SENDER, USDC] }),
  }).then((r) => r.json());
  const coin = res.result?.data?.[0];
  if (!coin) return console.log(`\n${SENDER} holds no native USDC on mainnet.`);
  console.log(`\nUsing USDC coin ${coin.coinObjectId.slice(0, 12)}… (balance ${Number(coin.balance) / 1e6} USDC)`);

  const tx = supplyTx(SENDER, coin.coinObjectId);
  const dr: any = await client.devInspectTransactionBlock({ sender: SENDER, transactionBlock: tx });
  const status = dr.effects?.status?.status;
  console.log(`DEV-INSPECT supply ${Number(AMOUNT) / 1e6} USDC → status: ${status}`);
  if (status !== "success") console.log("  error:", dr.effects?.status?.error);
  else console.log("  ✓ create_account_cap + deposit_with_account_cap execute against the live Navi USDC pool (simulated)");
}

main().catch((e) => { console.error(e); process.exit(1); });
