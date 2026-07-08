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
use sui::dynamic_field as df;
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

// ===================================================================
// EWMA volatility + latched trigger with hysteresis (additive upgrade).
//
// The original trigger is a single-print jump detector. This section
// generalizes it to the estimator the risk doc specifies (RISK-RESPONSIVE-
// REHYPOTHECATION.md §1): an EWMA variance — the GARCH(1,1) family reduced
// to one multiply-add — with TWO latch conditions (shock z-score, absolute
// regime ceiling) and an asymmetric release (deadband + N consecutive calm
// prints), per EMIR Art. 28's "avoid disruptive or big step changes".
//
// Upgrade constraint: `Feed`'s layout is frozen (published struct), so the
// vol state lives in a NEW struct stored as a dynamic field on the oracle,
// keyed per symbol. `push_price_v2` = `push_price` + vol update; feeds
// without vol state behave exactly as before.
// ===================================================================

/// Dynamic-field key for a feed's vol state.
public struct VolKey has copy, drop, store { symbol: String }

/// EWMA state + trigger calibration for one feed. All vol figures are in
/// bps of price per print; variance is bps² (u128 to survive the products).
public struct VolState has store {
    var_bps2: u128, // EWMA variance (bpsΔprint)²
    lambda_bps: u64, // decay λ (9400 = 0.94)
    z_latch_x100: u64, // shock latch z* × 100 (400 = 4.0σ)
    sigma_ceil_bps: u64, // regime latch: σ above this latches outright
    theta_rel_bps: u64, // release deadband θ (7000 = release only below 0.7·ceil)
    release_needed: u64, // N consecutive in-band prints to unlatch
    release_count: u64,
}

public struct VolUpdated has copy, drop {
    symbol: String,
    sigma_bps: u64,
    z_x100: u64,
    triggered: bool,
    auto_released: bool,
}

/// Admin arms EWMA vol tracking for an existing feed. `seed_sigma_bps` warms
/// the estimator (a cold start of 0 would make every first print an ∞-σ shock).
public fun enable_vol(
    oracle: &mut RiskOracle,
    _admin: &OracleAdminCap,
    symbol: String,
    seed_sigma_bps: u64,
    lambda_bps: u64,
    z_latch_x100: u64,
    sigma_ceil_bps: u64,
    theta_rel_bps: u64,
    release_needed: u64,
) {
    assert!(table::contains(&oracle.feeds, symbol), errors::e_no_feed());
    assert!(lambda_bps < 10_000, errors::e_bad_params());
    assert!(theta_rel_bps < 10_000, errors::e_bad_params());
    assert!(seed_sigma_bps > 0 && sigma_ceil_bps > 0 && release_needed > 0, errors::e_bad_params());
    df::add(
        &mut oracle.id,
        VolKey { symbol },
        VolState {
            var_bps2: (seed_sigma_bps as u128) * (seed_sigma_bps as u128),
            lambda_bps,
            z_latch_x100,
            sigma_ceil_bps,
            theta_rel_bps,
            release_needed,
            release_count: 0,
        },
    );
}

/// Admin retunes an ALREADY-armed feed's trigger calibration in place —
/// makes the vol layer genuinely admin-tunable (enable_vol is set-once; this is
/// how you change λ / z* / ceiling / deadband / N without disturbing the live
/// EWMA variance or the current trigger latch). `release_count` is reset so the
/// hysteresis restarts cleanly under the new deadband.
public fun retune_vol(
    oracle: &mut RiskOracle,
    _admin: &OracleAdminCap,
    symbol: String,
    lambda_bps: u64,
    z_latch_x100: u64,
    sigma_ceil_bps: u64,
    theta_rel_bps: u64,
    release_needed: u64,
) {
    assert!(df::exists_<VolKey>(&oracle.id, VolKey { symbol }), errors::e_no_feed());
    assert!(lambda_bps < 10_000, errors::e_bad_params());
    assert!(theta_rel_bps < 10_000, errors::e_bad_params());
    assert!(sigma_ceil_bps > 0 && release_needed > 0, errors::e_bad_params());
    let vs = df::borrow_mut<VolKey, VolState>(&mut oracle.id, VolKey { symbol });
    vs.lambda_bps = lambda_bps;
    vs.z_latch_x100 = z_latch_x100;
    vs.sigma_ceil_bps = sigma_ceil_bps;
    vs.theta_rel_bps = theta_rel_bps;
    vs.release_needed = release_needed;
    vs.release_count = 0;
}

/// Admin disarms EWMA tracking (feed reverts to the legacy jump trigger).
public fun disable_vol(oracle: &mut RiskOracle, _admin: &OracleAdminCap, symbol: String) {
    assert!(df::exists_<VolKey>(&oracle.id, VolKey { symbol }), errors::e_no_feed());
    let VolState { .. } = df::remove<VolKey, VolState>(&mut oracle.id, VolKey { symbol });
}

/// push_price + EWMA update + latch/release. Identical to `push_price` for
/// feeds without vol state, so keepers can switch to v2 unconditionally.
public fun push_price_v2(
    oracle: &mut RiskOracle,
    keeper: &KeeperCap,
    symbol: String,
    new_price: u64,
    clock: &Clock,
) {
    let prev = price(oracle, symbol); // asserts feed exists
    push_price(oracle, keeper, symbol, new_price, clock); // legacy jump latch intact
    if (!df::exists<VolKey>(&oracle.id, VolKey { symbol })) return;

    let r_bps = jump_bps(prev, new_price);
    let (sigma_bps, z_x100, latch, release_band) = {
        let vs = df::borrow_mut<VolKey, VolState>(&mut oracle.id, VolKey { symbol });
        // z against the PRE-update σ: a shock is a surprise vs. yesterday's calm.
        let sigma_pre = isqrt_u128(vs.var_bps2);
        let z_x100 = if (sigma_pre == 0) 0 else (r_bps as u128) * 100 / sigma_pre;
        // EWMA update: var ← (λ·var + (1−λ)·r²) / 1e4
        vs.var_bps2 =
            ((vs.lambda_bps as u128) * vs.var_bps2 +
             ((10_000 - vs.lambda_bps) as u128) * (r_bps as u128) * (r_bps as u128)) / 10_000;
        let sigma_bps = (isqrt_u128(vs.var_bps2) as u64);
        let latch = (z_x100 as u64) > vs.z_latch_x100 || sigma_bps > vs.sigma_ceil_bps;
        let release_band =
            sigma_bps < ((vs.sigma_ceil_bps as u128) * (vs.theta_rel_bps as u128) / 10_000 as u64)
            && (z_x100 as u64) <= vs.z_latch_x100;
        (sigma_bps, (z_x100 as u64), latch, release_band)
    };

    let feed = table::borrow_mut(&mut oracle.feeds, symbol);
    let mut auto_released = false;
    if (latch) {
        feed.triggered = true;
        let vs = df::borrow_mut<VolKey, VolState>(&mut oracle.id, VolKey { symbol });
        vs.release_count = 0;
    } else if (feed.triggered) {
        // hysteresis: unlatch only after `release_needed` consecutive prints
        // inside the deadband; any out-of-band print resets the count.
        let vs = df::borrow_mut<VolKey, VolState>(&mut oracle.id, VolKey { symbol });
        if (release_band) {
            vs.release_count = vs.release_count + 1;
            if (vs.release_count >= vs.release_needed) {
                feed.triggered = false;
                vs.release_count = 0;
                auto_released = true;
            }
        } else {
            vs.release_count = 0;
        }
    };
    event::emit(VolUpdated {
        symbol,
        sigma_bps,
        z_x100,
        triggered: feed.triggered,
        auto_released,
    });
}

// ---- vol views ----

public fun has_vol(oracle: &RiskOracle, symbol: String): bool {
    df::exists<VolKey>(&oracle.id, VolKey { symbol })
}

/// Current EWMA σ in bps-per-print (0 if vol not enabled).
public fun vol_bps(oracle: &RiskOracle, symbol: String): u64 {
    if (!has_vol(oracle, symbol)) return 0;
    (isqrt_u128(df::borrow<VolKey, VolState>(&oracle.id, VolKey { symbol }).var_bps2) as u64)
}

public fun release_progress(oracle: &RiskOracle, symbol: String): u64 {
    if (!has_vol(oracle, symbol)) return 0;
    df::borrow<VolKey, VolState>(&oracle.id, VolKey { symbol }).release_count
}

/// Integer sqrt (Newton), u128 → floor(sqrt).
fun isqrt_u128(x: u128): u128 {
    if (x < 2) return x;
    // Newton descent from an over-estimate. Initial guess (x+1)/2 sits ABOVE
    // sqrt(x) for all x >= 2, so the sequence decreases monotonically to
    // floor(sqrt(x)) (e.g. x=2 -> 1, x=3 -> 1, x=4 -> 2).
    let mut n = x;
    let mut y = (x + 1) / 2;
    while (y < n) {
        n = y;
        y = (x / y + y) / 2;
    };
    n
}
