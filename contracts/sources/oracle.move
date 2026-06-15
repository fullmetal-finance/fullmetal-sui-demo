/// Keeper-pushed price oracle with a built-in volatility trigger — the
/// "risk-responsive" signal that drives collateral recall. A keeper pushes
/// prices per underlying symbol; when a push moves the price more than the
/// feed's `jump_threshold_bps` versus the previous value, the feed latches
/// `triggered = true` (sticky until an admin clears it). The demo "crash button"
/// is simply a keeper pushing a far-off price.
///
/// Prices are u64 scaled by `PRICE_SCALE` (1e6 = USD with 6 decimals). For the
/// MVP this keeper oracle is deliberately simpler and more demo-controllable
/// than a Pyth pull integration (Pyth is available transitively and is the
/// stretch-goal upgrade — see openzeppelin-adoption notes).
module fullmetal::oracle;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use sui::table::{Self, Table};
use fullmetal::errors;

/// USD price scale (6 decimals): a price of $1.00 is stored as 1_000_000.
const PRICE_SCALE: u64 = 1_000_000;

/// One-time witness.
public struct ORACLE has drop {}

/// Can register feeds, mint keeper caps, and clear latched triggers.
public struct OracleAdminCap has key, store { id: UID }

/// Can push prices. Held by the off-chain keeper / demo operator.
public struct KeeperCap has key, store { id: UID }

/// Shared price book.
public struct RiskOracle has key {
    id: UID,
    feeds: Table<String, Feed>,
}

public struct Feed has store {
    price: u64, // current price (PRICE_SCALE)
    prev_price: u64, // price before the last push, for the jump calc
    last_update_ms: u64,
    jump_threshold_bps: u64, // latch `triggered` when |Δ|/prev exceeds this
    triggered: bool, // sticky until cleared by admin
}

public struct FeedRegistered has copy, drop { symbol: String, price: u64, jump_threshold_bps: u64 }
public struct PricePushed has copy, drop {
    symbol: String,
    price: u64,
    prev_price: u64,
    jump_bps: u64,
    triggered: bool,
    ts_ms: u64,
}
public struct TriggerCleared has copy, drop { symbol: String }

fun init(_otw: ORACLE, ctx: &mut TxContext) {
    init_internal(ctx);
}

#[allow(lint(self_transfer))]
fun init_internal(ctx: &mut TxContext) {
    transfer::share_object(RiskOracle { id: object::new(ctx), feeds: table::new(ctx) });
    transfer::public_transfer(OracleAdminCap { id: object::new(ctx) }, ctx.sender());
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init_internal(ctx) }

public fun mint_keeper_cap(_admin: &OracleAdminCap, ctx: &mut TxContext): KeeperCap {
    KeeperCap { id: object::new(ctx) }
}

public fun register_feed(
    oracle: &mut RiskOracle,
    _admin: &OracleAdminCap,
    symbol: String,
    initial_price: u64,
    jump_threshold_bps: u64,
    clock: &Clock,
) {
    assert!(!table::contains(&oracle.feeds, symbol), errors::e_feed_exists());
    assert!(initial_price > 0, errors::e_zero_price());
    let now = clock::timestamp_ms(clock);
    table::add(
        &mut oracle.feeds,
        symbol,
        Feed {
            price: initial_price,
            prev_price: initial_price,
            last_update_ms: now,
            jump_threshold_bps,
            triggered: false,
        },
    );
    event::emit(FeedRegistered { symbol, price: initial_price, jump_threshold_bps });
}

/// Push a new price. Latches the trigger if the move exceeds the threshold.
public fun push_price(
    oracle: &mut RiskOracle,
    _keeper: &KeeperCap,
    symbol: String,
    new_price: u64,
    clock: &Clock,
) {
    assert!(table::contains(&oracle.feeds, symbol), errors::e_no_feed());
    assert!(new_price > 0, errors::e_zero_price());
    let feed = table::borrow_mut(&mut oracle.feeds, symbol);
    let prev = feed.price;
    let jump_bps = jump_bps(prev, new_price);
    feed.prev_price = prev;
    feed.price = new_price;
    feed.last_update_ms = clock::timestamp_ms(clock);
    if (jump_bps > feed.jump_threshold_bps) {
        feed.triggered = true;
    };
    event::emit(PricePushed {
        symbol,
        price: new_price,
        prev_price: prev,
        jump_bps,
        triggered: feed.triggered,
        ts_ms: feed.last_update_ms,
    });
}

public fun clear_trigger(oracle: &mut RiskOracle, _admin: &OracleAdminCap, symbol: String) {
    assert!(table::contains(&oracle.feeds, symbol), errors::e_no_feed());
    let feed = table::borrow_mut(&mut oracle.feeds, symbol);
    feed.triggered = false;
    event::emit(TriggerCleared { symbol });
}

/// |new − prev| / prev in basis points, u128-intermediate to avoid overflow.
fun jump_bps(prev: u64, new_price: u64): u64 {
    if (prev == 0) return 0;
    let diff = if (new_price >= prev) new_price - prev else prev - new_price;
    (((diff as u128) * 10_000) / (prev as u128)) as u64
}

// ---- views ----

public fun price(oracle: &RiskOracle, symbol: String): u64 {
    assert!(table::contains(&oracle.feeds, symbol), errors::e_no_feed());
    table::borrow(&oracle.feeds, symbol).price
}

public fun is_triggered(oracle: &RiskOracle, symbol: String): bool {
    assert!(table::contains(&oracle.feeds, symbol), errors::e_no_feed());
    table::borrow(&oracle.feeds, symbol).triggered
}

public fun has_feed(oracle: &RiskOracle, symbol: String): bool {
    table::contains(&oracle.feeds, symbol)
}

public fun last_update_ms(oracle: &RiskOracle, symbol: String): u64 {
    assert!(table::contains(&oracle.feeds, symbol), errors::e_no_feed());
    table::borrow(&oracle.feeds, symbol).last_update_ms
}

public fun price_scale(): u64 { PRICE_SCALE }
