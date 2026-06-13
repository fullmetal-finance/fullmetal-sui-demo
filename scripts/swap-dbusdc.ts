/**
 * M0 step 1 — acquire DBUSDC on Sui testnet.
 *
 * DBUSDC is DeepBook's testnet stablecoin (the "USDC" of every testnet margin
 * pool / order book). Its TreasuryCap is privately owned, so the way to get it
 * is to swap faucet SUI on the SUI/DBUSDC DeepBook pool.
 *
 * Usage: npx tsx swap-dbusdc.ts [targetDbusdc]   (default 1 DBUSDC)
 *
 * Signs with the Sui CLI active address (reads ~/.sui/sui_config).
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { deepbook, testnetCoins } from '@mysten/deepbook-v3';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';

const SUI_CONFIG = join(homedir(), '.sui', 'sui_config');
const POOL_KEY = 'SUI_DBUSDC';
const SUI_SCALAR = 1e9;
const DBUSDC_SCALAR = 1e6;
const GAS_RESERVE_SUI = 0.2; // keep this much SUI for gas

function loadActiveKeypair(): Ed25519Keypair {
  // SUI_ADDRESS env overrides the CLI active address (must still be in the keystore)
  let activeAddress = process.env.SUI_ADDRESS;
  if (!activeAddress) {
    const clientYaml = readFileSync(join(SUI_CONFIG, 'client.yaml'), 'utf8');
    activeAddress = clientYaml.match(/active_address:\s*"?(0x[0-9a-fA-F]+)"?/)?.[1];
  }
  if (!activeAddress) throw new Error('Could not parse active_address from client.yaml');

  const keys: string[] = JSON.parse(readFileSync(join(SUI_CONFIG, 'sui.keystore'), 'utf8'));
  for (const b64 of keys) {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes[0] !== 0) continue; // 0x00 = ed25519; skip other schemes
    const kp = Ed25519Keypair.fromSecretKey(bytes.subarray(1));
    if (kp.toSuiAddress() === activeAddress) return kp;
  }
  throw new Error(`No ed25519 key in keystore for active address ${activeAddress}`);
}

async function main() {
  const targetDbusdc = Number(process.argv[2] ?? '1');
  const keypair = loadActiveKeypair();
  const address = keypair.toSuiAddress();
  console.log(`Address:        ${address}`);

  const client = new SuiGrpcClient({
    network: 'testnet',
    baseUrl: 'https://fullnode.testnet.sui.io:443',
  }).$extend(deepbook({ address }));

  const suiBalance = await client.core.getBalance({ owner: address, coinType: '0x2::sui::SUI' });
  const suiHuman = Number(suiBalance.balance.balance) / SUI_SCALAR;
  console.log(`SUI balance:    ${suiHuman}`);

  // --- check the book before swapping ---
  const mid = await client.deepbook.midPrice(POOL_KEY);
  const { lotSize, minSize } = await client.deepbook.poolBookParams(POOL_KEY);
  console.log(`${POOL_KEY} mid: ${mid} DBUSDC per SUI (lot ${lotSize}, min ${minSize})`);

  // how much SUI to sell for the target, +20% buffer for thin testnet books,
  // rounded to lot size and clamped to the pool's minimum order size
  let baseIn = (targetDbusdc / mid) * 1.2;
  baseIn = Math.max(minSize, Math.ceil(baseIn / lotSize) * lotSize);
  const maxBase = suiHuman - GAS_RESERVE_SUI;
  if (baseIn > maxBase) {
    throw new Error(
      `Need to sell ${baseIn} SUI (pool min ${minSize}) but only ${maxBase.toFixed(2)} SUI is spare after gas — get more from https://faucet.sui.io`,
    );
  }

  // we pay taker fees in the input coin (deepAmount: 0), so quote with input fee;
  // the fee comes off the input first, so the post-fee amount must still clear minSize
  const quote = await client.deepbook.getQuoteQuantityOutInputFee(POOL_KEY, baseIn);
  console.log(`Quote:          selling ${baseIn.toFixed(4)} SUI -> ~${quote.quoteOut} DBUSDC`);
  if (quote.quoteOut <= 0) {
    throw new Error('Quoted 0 out — either no resting bids or post-fee amount is below pool minSize.');
  }

  // --- build & execute the swap ---
  const tx = new Transaction();
  const [baseRemainder, quoteOut, deepRemainder] = tx.add(
    client.deepbook.deepBook.swapExactBaseForQuote({
      poolKey: POOL_KEY,
      amount: baseIn,
      deepAmount: 0, // zero DEEP coin => DeepBook takes the taker fee from the input SUI
      minOut: 0,     // test swap on testnet; set a real min in production
    }),
  );
  tx.transferObjects([baseRemainder, quoteOut], address);
  // the swap API always hands back a Coin<DEEP> remainder; ours is always zero
  // (fees paid in input coin), so burn the empty object instead of sending
  // 0-DEEP dust to the wallet
  tx.moveCall({
    target: '0x2::coin::destroy_zero',
    typeArguments: [testnetCoins.DEEP.type],
    arguments: [deepRemainder],
  });

  const result = await client.core.signAndExecuteTransaction({
    transaction: tx,
    signer: keypair,
    include: { effects: true },
  });
  if (result.$kind === 'FailedTransaction') {
    throw new Error(`Swap failed: ${JSON.stringify(result.FailedTransaction.status)}`);
  }
  console.log(`Swap executed:  ${result.Transaction.digest}`);
  await client.core.waitForTransaction({ digest: result.Transaction.digest });

  // --- verify ---
  const dbusdc = await client.core.getBalance({ owner: address, coinType: testnetCoins.DBUSDC.type });
  console.log(`DBUSDC balance: ${Number(dbusdc.balance.balance) / DBUSDC_SCALAR} DBUSDC`);
  console.log(`Explorer:       https://suiscan.xyz/testnet/tx/${result.Transaction.digest}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
