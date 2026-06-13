/**
 * Read live state of the testnet DBUSDC margin pool: supply, borrow,
 * utilization, interest rates, rate-limiter state — the numbers our
 * rehypothecation yield depends on.
 *
 * Usage: npx tsx margin-pool-stats.ts
 */
import { deepbook, testnetMarginPools } from '@mysten/deepbook-v3';
import { SuiGrpcClient } from '@mysten/sui/grpc';

const YEAR_MS = 365n * 24n * 60n * 60n * 1000n;
const FP = 1e9; // deepbook 9-decimal fixed point
const DBUSDC = 1e6;

const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
}).$extend(deepbook({ address: '0x6849af55b4f2f429cb2665ec9f4d42c17eecc76211f14caf959903ad786d5576' }));

const poolId = testnetMarginPools.DBUSDC.address;
const obj = await client.core.getObject({ objectId: poolId, include: { json: true } });
const f: any = obj.object.json;

const state = f.state;
const cfg = f.config;
const interest = cfg.interest_config;
const margin = cfg.margin_pool_config;

const totalSupply = Number(state.total_supply);
const totalBorrow = Number(state.total_borrow);
const vault = Number(f.vault);
const utilization = totalSupply > 0 ? totalBorrow / totalSupply : 0;

// kinked rate curve (same math as margin_state.move)
const base = Number(interest.base_rate) / FP;
const slope = Number(interest.base_slope) / FP;
const optimal = Number(interest.optimal_utilization) / FP;
const excess = Number(interest.excess_slope) / FP;
const spread = Number(margin.protocol_spread) / FP;
let borrowApr = base + utilization * slope;
if (utilization > optimal) borrowApr += (utilization - optimal) * excess;
const supplierApr = borrowApr * utilization * (1 - spread);

// interest accrued since the pool was last touched
const lastUpdate = Number(state.last_update_timestamp);
const elapsedMs = Date.now() - lastUpdate;
const pendingInterest = (totalBorrow * borrowApr * elapsedMs) / Number(YEAR_MS);

console.log(`DBUSDC margin pool ${poolId}`);
console.log(`  total supplied:   ${(totalSupply / DBUSDC).toFixed(2)} DBUSDC (${state.supply_shares} shares)`);
console.log(`  total borrowed:   ${(totalBorrow / DBUSDC).toFixed(2)} DBUSDC (${state.borrow_shares} shares)`);
console.log(`  vault (liquid):   ${(vault / DBUSDC).toFixed(2)} DBUSDC`);
console.log(`  utilization:      ${(utilization * 100).toFixed(2)}%`);
console.log(`  borrow APR:       ${(borrowApr * 100).toFixed(2)}%`);
console.log(`  supplier APR:     ${(supplierApr * 100).toFixed(4)}%  (after ${spread * 100}% protocol spread)`);
console.log(`  supply cap:       ${(Number(margin.supply_cap) / DBUSDC).toFixed(0)} DBUSDC`);
console.log(`  max utilization:  ${Number(margin.max_utilization_rate) / FP * 100}%`);
console.log(`  rate curve:       base ${base * 100}% + slope ${slope * 100}% to ${optimal * 100}% util, then +${excess * 100}%`);
console.log(`  last touched:     ${new Date(lastUpdate).toISOString()} (${(elapsedMs / 3600e3).toFixed(1)}h ago)`);
console.log(`  pending interest: ${(pendingInterest / DBUSDC).toFixed(6)} DBUSDC accrues on next touch`);

const rl = f.rate_limiter;
if (rl) console.log(`  rate limiter:     ${JSON.stringify(rl)}`);
