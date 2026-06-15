/// Bilateral OTC forward — a bespoke, negotiated contract between two
/// institutions, modeled as its OWN shared object (vs. a standardized
/// exchange-traded "position-as-row"). The long profits when the underlying
/// rises. Each side posts initial margin reserved from its pooled collateral;
/// daily (interval-chosen) mark-to-market moves variation margin from loser to
/// winner; a fixed funding rate accrues per interval; and the position
/// auto-liquidates when the loser can no longer cover from its buffer.
///
/// Signed PnL uses OpenZeppelin `fp_math` SD29x9 (Move has no native signed
/// ints); funding/notional/maintenance use OZ `math::u128::mul_div`. Prices and
/// quantities are 1e6-scaled; collateral (C, e.g. DBUSDC) is 6 decimals.
module fullmetal::otc_forward;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use openzeppelin_fp_math::sd29x9;
use openzeppelin_fp_math::sd29x9_base;
use openzeppelin_fp_math::ud30x9;
use openzeppelin_fp_math::ud30x9_base;
use openzeppelin_math::rounding;
use openzeppelin_math::u128 as oz128;
use fullmetal::errors;
use fullmetal::institution::{Self, Institution, TraderCap};
use fullmetal::oracle::{Self, RiskOracle};
use fullmetal::protocol::OtcAllowlist;
use fullmetal::settlement;

const PRICE_UNIT: u64 = 1_000_000; // 1e6 scale for prices and quantities
const MAINTENANCE_BPS: u64 = 7_000; // maintenance margin = 70% of IM
const U64_MAX: u128 = 18_446_744_073_709_551_615;

const STATUS_ACTIVE: u8 = 0;
const STATUS_SETTLED: u8 = 1; // closed normally at expiry
const STATUS_LIQUIDATED: u8 = 2;

/// Witness authorizing this module to reserve/release margin and settle between
/// institutions. Must be allowlisted by the ProtocolCap holder at deploy.
public struct OtcWitness has drop {}

/// One bilateral forward. Shared so both counterparties + any keeper can act.
public struct OtcForward<phantom C> has key {
    id: UID,
    inst_long: ID,
    inst_short: ID,
    trader_long: address,
    trader_short: address,
    underlying: String, // oracle feed symbol
    notional: u64, // quantity of underlying (1e6)
    notional_6dp: u64, // USD notional at entry (collateral 6dp), cached
    entry_price: u64, // USD per unit (1e6)
    im_each: u64, // initial margin each side (6dp)
    maintenance_each: u64, // maintenance threshold each side (6dp)
    funding_rate_bps: u64, // fixed funding per interval
    funding_long_pays: bool, // direction: true = long pays short
    settlement_interval_ms: u64,
    expiry_ms: u64, // 0 = perpetual (no expiry close)
    last_mark: u64, // mark at last settlement (1e6)
    last_settle_ms: u64,
    status: u8,
}

public struct ContractOpened has copy, drop {
    otc_id: ID,
    inst_long: ID,
    inst_short: ID,
    underlying: String,
    notional: u64,
    entry_price: u64,
    im_each: u64,
}
public struct IntervalSettled has copy, drop {
    otc_id: ID,
    mark: u64,
    short_paid_long: bool,
    amount: u64,
    ts_ms: u64,
}
public struct ContractLiquidated has copy, drop { otc_id: ID, mark: u64, recovered: u64 }
public struct ContractClosed has copy, drop { otc_id: ID, mark: u64, final_amount: u64 }

/// Open a bilateral forward: reserve IM from both pools, create + share the
/// contract object. `notional`/`entry_price` are 1e6-scaled; `im_each` is 6dp.
public fun open<C>(
    long_inst: &mut Institution<C>,
    long_trader: &TraderCap,
    short_inst: &mut Institution<C>,
    short_trader: &TraderCap,
    allow: &OtcAllowlist,
    underlying: String,
    notional: u64,
    entry_price: u64,
    im_each: u64,
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let long_id = object::id(long_inst);
    let short_id = object::id(short_inst);
    assert!(long_id != short_id, errors::e_not_counterparties());
    assert!(notional > 0, errors::e_zero_notional());
    assert!(entry_price > 0, errors::e_zero_price());

    let maintenance = muldiv(im_each, MAINTENANCE_BPS, 10_000, false);
    let notional_6dp = muldiv(entry_price, notional, PRICE_UNIT, false);
    let now = clock::timestamp_ms(clock);

    let fwd = OtcForward<C> {
        id: object::new(ctx),
        inst_long: long_id,
        inst_short: short_id,
        trader_long: institution::trader_of_cap(long_trader),
        trader_short: institution::trader_of_cap(short_trader),
        underlying,
        notional,
        notional_6dp,
        entry_price,
        im_each,
        maintenance_each: maintenance,
        funding_rate_bps,
        funding_long_pays,
        settlement_interval_ms,
        expiry_ms,
        last_mark: entry_price,
        last_settle_ms: now,
        status: STATUS_ACTIVE,
    };
    let otc_id = object::id(&fwd);

    institution::reserve_margin<C, OtcWitness>(
        long_inst, OtcWitness {}, allow, long_trader, otc_id, short_id, im_each, maintenance,
    );
    institution::reserve_margin<C, OtcWitness>(
        short_inst, OtcWitness {}, allow, short_trader, otc_id, long_id, im_each, maintenance,
    );

    event::emit(ContractOpened {
        otc_id,
        inst_long: long_id,
        inst_short: short_id,
        underlying: fwd.underlying,
        notional,
        entry_price,
        im_each,
    });
    transfer::share_object(fwd);
}

/// Interval mark-to-market. Anyone (a keeper) may call once the interval has
/// elapsed. Moves net VM+funding from loser to winner; if the loser cannot
/// cover from its free funds, auto-liquidates.
public fun settle<C>(
    fwd: &mut OtcForward<C>,
    long_inst: &mut Institution<C>,
    short_inst: &mut Institution<C>,
    oracle: &RiskOracle,
    allow: &OtcAllowlist,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_parties(fwd, long_inst, short_inst);
    assert!(fwd.status == STATUS_ACTIVE, errors::e_contract_not_active());
    assert!(oracle::has_feed(oracle, fwd.underlying), errors::e_wrong_oracle_feed());
    let now = clock::timestamp_ms(clock);
    assert!(now >= fwd.last_settle_ms + fwd.settlement_interval_ms, errors::e_not_due_yet());

    let mark = oracle::price(oracle, fwd.underlying);
    let (short_pays_long, amount) = compute_net(fwd, mark);
    let otc_id = object::id(fwd);

    if (amount == 0) {
        fwd.last_mark = mark;
        fwd.last_settle_ms = now;
        return
    };

    if (short_pays_long) {
        if (institution::available(short_inst) >= amount) {
            transfer_net(short_inst, long_inst, allow, otc_id, amount, ctx);
            fwd.last_mark = mark;
            fwd.last_settle_ms = now;
            event::emit(IntervalSettled { otc_id, mark, short_paid_long: true, amount, ts_ms: now });
        } else {
            let recovered = final_settle(fwd, short_inst, long_inst, allow, amount, STATUS_LIQUIDATED, ctx);
            event::emit(ContractLiquidated { otc_id, mark, recovered });
        }
    } else {
        if (institution::available(long_inst) >= amount) {
            transfer_net(long_inst, short_inst, allow, otc_id, amount, ctx);
            fwd.last_mark = mark;
            fwd.last_settle_ms = now;
            event::emit(IntervalSettled { otc_id, mark, short_paid_long: false, amount, ts_ms: now });
        } else {
            let recovered = final_settle(fwd, long_inst, short_inst, allow, amount, STATUS_LIQUIDATED, ctx);
            event::emit(ContractLiquidated { otc_id, mark, recovered });
        }
    }
}

/// Close at/after expiry: final mark-to-market, release both IMs, mark settled.
public fun close<C>(
    fwd: &mut OtcForward<C>,
    long_inst: &mut Institution<C>,
    short_inst: &mut Institution<C>,
    oracle: &RiskOracle,
    allow: &OtcAllowlist,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert_parties(fwd, long_inst, short_inst);
    assert!(fwd.status == STATUS_ACTIVE, errors::e_contract_not_active());
    assert!(
        fwd.expiry_ms > 0 && clock::timestamp_ms(clock) >= fwd.expiry_ms,
        errors::e_not_expired(),
    );
    let mark = oracle::price(oracle, fwd.underlying);
    let (short_pays_long, amount) = compute_net(fwd, mark);
    let otc_id = object::id(fwd);
    let final_amount = if (short_pays_long) {
        final_settle(fwd, short_inst, long_inst, allow, amount, STATUS_SETTLED, ctx)
    } else {
        final_settle(fwd, long_inst, short_inst, allow, amount, STATUS_SETTLED, ctx)
    };
    event::emit(ContractClosed { otc_id, mark, final_amount });
}

// ---- views ----

public fun status<C>(fwd: &OtcForward<C>): u8 { fwd.status }

public fun mark<C>(fwd: &OtcForward<C>): u64 { fwd.last_mark }

public fun parties<C>(fwd: &OtcForward<C>): (ID, ID) { (fwd.inst_long, fwd.inst_short) }

/// Long-side PnL at `price_1e6` vs entry, in collateral 6dp + profit flag.
public fun pnl_at<C>(fwd: &OtcForward<C>, price_1e6: u64): (u64, bool) {
    pnl_6dp(fwd.entry_price, price_1e6, fwd.notional)
}

// ---- internal ----

fun assert_parties<C>(fwd: &OtcForward<C>, long_inst: &Institution<C>, short_inst: &Institution<C>) {
    assert!(
        object::id(long_inst) == fwd.inst_long && object::id(short_inst) == fwd.inst_short,
        errors::e_not_counterparties(),
    );
}

/// Net obligation for this step (VM from last_mark→mark, plus one funding
/// accrual). Returns (short_pays_long, amount_6dp).
fun compute_net<C>(fwd: &OtcForward<C>, mark_1e6: u64): (bool, u64) {
    let (vm_mag, long_gains) = pnl_6dp(fwd.last_mark, mark_1e6, fwd.notional);
    let funding = muldiv(fwd.notional_6dp, fwd.funding_rate_bps, 10_000, true);

    let mut long_credit = 0u64;
    let mut long_debit = 0u64;
    if (long_gains) long_credit = long_credit + vm_mag else long_debit = long_debit + vm_mag;
    if (fwd.funding_long_pays) long_debit = long_debit + funding
    else long_credit = long_credit + funding;

    if (long_credit >= long_debit) (true, long_credit - long_debit)
    else (false, long_debit - long_credit)
}

/// Move `amount` from payer to payee atomically (hot-potato settlement).
/// `begin_settlement` enforces `amount <= available(payer)`.
fun transfer_net<C>(
    payer: &mut Institution<C>,
    payee: &mut Institution<C>,
    allow: &OtcAllowlist,
    otc_id: ID,
    amount: u64,
    ctx: &mut TxContext,
) {
    if (amount == 0) return;
    let ticket = settlement::begin_settlement<C, OtcWitness>(
        payer, OtcWitness {}, allow, object::id(payee), otc_id, amount,
    );
    settlement::finish_settlement<C>(payee, ticket, ctx);
}

/// Terminal settle: release both IMs (freeing the buffer), pay the winner what
/// the loser can cover, set the terminal status. Returns the amount recovered.
fun final_settle<C>(
    fwd: &mut OtcForward<C>,
    payer: &mut Institution<C>,
    payee: &mut Institution<C>,
    allow: &OtcAllowlist,
    owed: u64,
    new_status: u8,
    ctx: &mut TxContext,
): u64 {
    let otc_id = object::id(fwd);
    institution::release_margin<C, OtcWitness>(payer, OtcWitness {}, allow, otc_id);
    institution::release_margin<C, OtcWitness>(payee, OtcWitness {}, allow, otc_id);
    let pay = min(owed, institution::available(payer));
    transfer_net(payer, payee, allow, otc_id, pay, ctx);
    fwd.status = new_status;
    pay
}

/// Long PnL from `from_price` to `to_price` over `qty`, all 1e6-scaled, returned
/// as (magnitude in collateral 6dp, long_in_profit). Uses SD29x9 for the signed
/// arithmetic; for a non-negative SD29x9, raw bits = value*1e9, so /1000 yields
/// the 6dp magnitude.
fun pnl_6dp(from_price_1e6: u64, to_price_1e6: u64, qty_1e6: u64): (u64, bool) {
    let to_p = ud30x9_base::into_SD29x9(ud30x9::wrap((to_price_1e6 as u128) * 1000));
    let from_p = ud30x9_base::into_SD29x9(ud30x9::wrap((from_price_1e6 as u128) * 1000));
    let qty = ud30x9_base::into_SD29x9(ud30x9::wrap((qty_1e6 as u128) * 1000));
    let pnl = sd29x9_base::mul(sd29x9_base::sub(to_p, from_p), qty);
    let long_gains = !sd29x9_base::lt(pnl, sd29x9::zero());
    let mag_6dp = (sd29x9::unwrap(sd29x9_base::abs(pnl)) / 1000) as u64;
    (mag_6dp, long_gains)
}

/// a*b/d via OZ audited mul_div; asserts the result fits u64 (no silent trunc).
fun muldiv(a: u64, b: u64, d: u64, round_up: bool): u64 {
    let mode = if (round_up) rounding::up() else rounding::down();
    let v = oz128::mul_div(a as u128, b as u128, d as u128, mode).destroy_some();
    assert!(v <= U64_MAX, errors::e_insufficient_treasury());
    v as u64
}

fun min(a: u64, b: u64): u64 { if (a < b) a else b }
