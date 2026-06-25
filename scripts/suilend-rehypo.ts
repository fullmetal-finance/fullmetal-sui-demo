/**
 * Suilend rehypothecation integration — MAINNET (Suilend is mainnet-only).
 *
 * Exercises the live Suilend USDC market the same way an Institution would
 * rehypothecate: supply USDC -> mint the yield-bearing CToken receipt (held by
 * the supplier, so a shared object could hold it) -> redeem back to USDC.
 *
 * Modes (no Move package linking required — pure PTBs against the live market):
 *   npx tsx suilend-rehypo.ts
 *       read-only: prints the live USDC reserve state + cToken ratio, proves
 *       the market is reachable. No funds, no sender needed.
 *   SUI_SENDER=0x<addr> npx tsx suilend-rehypo.ts
 *       DRY-RUN supply->redeem against mainnet (dryRunTransactionBlock — no
 *       commit, no funds moved). <addr> must hold a little USDC + SUI on mainnet.
 *   The REAL run (sign + execute) is intentionally NOT wired here — gated.
 */
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";

const client = new SuiJsonRpcClient({ network: "mainnet", url: getJsonRpcFullnodeUrl("mainnet") });

// ---- Suilend mainnet objects ----
// PKG = original/type id (types — MAIN_POOL, CToken, RateLimiterExemption — key here).
// PKG_AT = current upgraded package id (call functions here, else EIncorrectVersion).
const PKG = "0xf95b06141ed4a174f239417323bde3f209b972f5930d8521ea38a52aff3a6ddf";
const PKG_AT = "0xe53906c2c058d1e369763114418f3c144d1b74960d29b2785718a782fec09b61";
const MARKET = "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";
const MAIN_POOL = `${PKG}::suilend::MAIN_POOL`;
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const RESERVE_INDEX = 7n; // native-USDC reserve in the main market
const CLOCK = "0x6";
const AMOUNT = BigInt(process.env.AMOUNT ?? "1000000"); // 1 USDC (6dp)

const DEPOSIT = `${PKG_AT}::lending_market::deposit_liquidity_and_mint_ctokens`;
const REDEEM = `${PKG_AT}::lending_market::redeem_ctokens_and_withdraw_liquidity`;
const EXEMPTION = `${PKG}::lending_market::RateLimiterExemption<${MAIN_POOL}, ${USDC}>`;

/* eslint-disable @typescript-eslint/no-explicit-any */
async function readReserve(): Promise<number> {
  const o = await client.getObject({ id: MARKET, options: { showContent: true } });
  const reserves = (o.data?.content as any)?.fields?.reserves;
  const f = reserves[Number(RESERVE_INDEX)].fields;
  const name = f.coin_type?.fields?.name ?? "";
  const avail = Number(f.available_amount);
  const borrowed = Number(f.borrowed_amount?.fields?.value ?? 0) / 1e18;
  const ctokenSupply = Number(f.ctoken_supply);
  const ratio = ctokenSupply > 0 ? (avail + borrowed) / ctokenSupply : 1; // USDC per cToken
  console.log(`Suilend USDC reserve [idx ${RESERVE_INDEX}] coin=${name.slice(0, 14)}…`);
  console.log(`  available=${(avail / 1e6).toFixed(2)}  borrowed=${(borrowed / 1e6).toFixed(2)}  ctoken_supply=${(ctokenSupply / 1e6).toFixed(2)}`);
  console.log(`  cToken→USDC ratio ≈ ${ratio.toFixed(6)}  (${AMOUNT} base USDC ≈ ${(Number(AMOUNT) / ratio / 1).toFixed(0)} base cUSDC)`);
  return ratio;
}

function supplyTx(sender: string, usdcCoinId: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const [coin] = tx.splitCoins(tx.object(usdcCoinId), [AMOUNT]);
  const ctoken = tx.moveCall({
    target: DEPOSIT,
    typeArguments: [MAIN_POOL, USDC],
    arguments: [tx.object(MARKET), tx.pure.u64(RESERVE_INDEX), tx.object(CLOCK), coin],
  });
  tx.transferObjects([ctoken], sender); // an Institution would stash this instead
  return tx;
}

// redeem path for reference (run after supply, with the minted CToken coin id)
export function redeemTx(sender: string, ctokenCoinId: string): Transaction {
  const tx = new Transaction();
  tx.setSender(sender);
  const none = tx.moveCall({ target: "0x1::option::none", typeArguments: [EXEMPTION] });
  const usdc = tx.moveCall({
    target: REDEEM,
    typeArguments: [MAIN_POOL, USDC],
    arguments: [tx.object(MARKET), tx.pure.u64(RESERVE_INDEX), tx.object(CLOCK), tx.object(ctokenCoinId), none],
  });
  tx.transferObjects([usdc], sender);
  return tx;
}

async function main() {
  console.log("— Suilend mainnet rehypothecation (read + dry-run) —\n");
  await readReserve();

  const SENDER = process.env.SUI_SENDER;
  if (!SENDER) {
    console.log("\nReachable ✓. To DRY-RUN supply (no funds moved):");
    console.log("  SUI_SENDER=<mainnet addr holding ~1 USDC> npx tsx suilend-rehypo.ts");
    return;
  }
  // devInspect needs NO gas/SUI — pure simulation against live state. Fetch a
  // USDC coin via raw RPC (robust across SDK client shapes).
  const res = await fetch(getJsonRpcFullnodeUrl("mainnet"), {
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
  else console.log("  ✓ deposit_liquidity_and_mint_ctokens executes against the live Suilend reserve (CToken minted in simulation)");
}

main().catch((e) => { console.error(e); process.exit(1); });
