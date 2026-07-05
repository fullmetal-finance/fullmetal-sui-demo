/// Venue-agnostic rehypothecation router + per-institution collateral config.
///
/// WHY THIS EXISTS. The original `rehypo` module hard-links DeepBook and lives
/// inside this package, so it can use the institution's `public(package)` seams
/// directly. That works for the testnet demo but cannot extend to Suilend / Navi:
/// those are mainnet-only and each drags in its own (mirror) Pyth/Wormhole graph,
/// so their adapters must compile as SEPARATE packages. A separate package cannot
/// touch `treasury_mut` / `note_supplied` (they are `public(package)`).
///
/// This module is the safe public seam between the core and ANY external venue
/// adapter. It never imports a venue type. An adapter package drives a round-trip
/// through two hot-potato tickets that CANNOT be dropped, so the treasury can only
/// be debited if the deposit-and-store completes in the same transaction:
///
///   supply:  (coin, ticket) = withdraw_for_rehypo(inst, cap, venue, amt)
///            receipt        = <venue>_adapter::supply(coin, ...)   // typed, real call
///            confirm_rehypo(inst, ticket, receipt, ctx)            // stores receipt + accounts
///
///   recall:  (receipt, ticket) = begin_recall<C, R>(inst, cap, venue)
///            coin               = <venue>_adapter::recall(receipt, ...) // typed redeem
///            finish_recall(inst, ticket, coin, ctx)                     // funds back + accounts
///
/// Receipts (DeepBook SupplierCap / Suilend `Coin<CToken>` / Navi AccountCap) are
/// stored generically as dynamic fields keyed by venue id, so the core stays free
/// of every venue dependency while still custodying the lender handle. The single
/// `rehypothecated` mirror on the institution keeps counting funds across ALL
/// venues automatically, so `equity()` / `available()` need no change.
module fullmetal::rehypo_router;

use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use fullmetal::errors;
use fullmetal::institution::{Self, Institution, AdminCap};

// ---- venue ids (stable wire values; receipts/principal key on these) ----
const DEEPBOOK: u8 = 0;
const SUILEND: u8 = 1;
const NAVI: u8 = 2;

public fun venue_deepbook(): u8 { DEEPBOOK }
public fun venue_suilend(): u8 { SUILEND }
public fun venue_navi(): u8 { NAVI }

const BPS_DENOM: u16 = 10_000;

// ===================================================================
// Per-institution config (admin-tunable, stored as a dynamic field so
// it needs NO change to the frozen `Institution` struct on upgrade).
// ===================================================================

public struct ConfigKey has copy, drop, store {}

/// The collateral policy + venue routing a firm controls for itself.
public struct RehypoConfig has store {
    init_margin_bps: u16, // initial-margin ratio applied to new contracts (1e4 = 100%)
    maint_margin_bps: u16, // maintenance-margin floor
    recall_trigger_bps: u16, // volatility move that latches a risk recall
    // Liquidity floor F = max(stress_floor, phi_bps · reserved / 1e4) — the
    // RISK-RESPONSIVE-REHYPOTHECATION.md §2 invariant T ≥ F. `stress_floor`
    // is the keeper-estimated O_stress (absolute units); `phi_bps` is the
    // unconditional 25%-of-reserved-IM floor (EMIR Art.28(a) / LCR ¶69 analog).
    stress_floor: u64,
    phi_bps: u16,
    venues: vector<VenueCfg>,
}

public struct VenueCfg has copy, drop, store {
    venue: u8,
    enabled: bool,
    cap: u64, // max principal routed to this venue (0 = unlimited)
    target_weight_bps: u16, // desired share of rehypothecated capital
}

/// Dynamic-field keys for per-venue receipt + principal (one slot per venue id).
public struct ReceiptKey has copy, drop, store { venue: u8 }
public struct PrincipalKey has copy, drop, store { venue: u8 }

/// Lazily install a sane default config the first time it is read/written.
fun ensure_config<C>(inst: &mut Institution<C>) {
    if (!df::exists<ConfigKey>(institution::uid(inst), ConfigKey {})) {
        let cfg = RehypoConfig {
            init_margin_bps: 500, // 5% IM  => up to 20x
            maint_margin_bps: 350, // 3.5% MM (70% of IM)
            recall_trigger_bps: 1500, // 15% move latches a recall
            stress_floor: 0, // keeper-estimated O_stress; 0 until first push
            phi_bps: 2500, // liquid ≥ 25% of reserved IM, unconditionally
            venues: vector[
                VenueCfg { venue: DEEPBOOK, enabled: true, cap: 0, target_weight_bps: 5000 },
                VenueCfg { venue: SUILEND, enabled: true, cap: 0, target_weight_bps: 3000 },
                VenueCfg { venue: NAVI, enabled: true, cap: 0, target_weight_bps: 2000 },
            ],
        };
        df::add(institution::uid_mut(inst), ConfigKey {}, cfg);
    }
}

/// Admin updates the collateral policy. bps are sanity-bounded (≤ 100%).
public fun set_collateral_params<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    init_margin_bps: u16,
    maint_margin_bps: u16,
    recall_trigger_bps: u16,
) {
    institution::assert_admin(inst, cap);
    assert!(init_margin_bps > 0 && init_margin_bps <= BPS_DENOM, errors::e_bad_params());
    assert!(maint_margin_bps > 0 && maint_margin_bps <= init_margin_bps, errors::e_bad_params());
    assert!(recall_trigger_bps > 0 && recall_trigger_bps <= BPS_DENOM, errors::e_bad_params());
    ensure_config(inst);
    let cfg = df::borrow_mut<ConfigKey, RehypoConfig>(institution::uid_mut(inst), ConfigKey {});
    cfg.init_margin_bps = init_margin_bps;
    cfg.maint_margin_bps = maint_margin_bps;
    cfg.recall_trigger_bps = recall_trigger_bps;
}

/// Admin enables/disables a venue and sets its principal cap + target weight.
public fun set_venue_config<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    venue: u8,
    enabled: bool,
    venue_cap: u64,
    target_weight_bps: u16,
) {
    institution::assert_admin(inst, cap);
    assert!(venue <= NAVI, errors::e_bad_params());
    assert!(target_weight_bps <= BPS_DENOM, errors::e_bad_params());
    ensure_config(inst);
    let cfg = df::borrow_mut<ConfigKey, RehypoConfig>(institution::uid_mut(inst), ConfigKey {});
    let mut i = 0;
    let n = vector::length(&cfg.venues);
    while (i < n) {
        let v = vector::borrow_mut(&mut cfg.venues, i);
        if (v.venue == venue) {
            v.enabled = enabled;
            v.cap = venue_cap;
            v.target_weight_bps = target_weight_bps;
            return
        };
        i = i + 1;
    };
    vector::push_back(
        &mut cfg.venues,
        VenueCfg { venue, enabled, cap: venue_cap, target_weight_bps },
    );
}

/// Read the collateral policy: (init_margin_bps, maint_margin_bps, recall_trigger_bps).
/// Returns the defaults if the firm never customised it.
public fun collateral_params<C>(inst: &Institution<C>): (u16, u16, u16) {
    if (!df::exists<ConfigKey>(institution::uid(inst), ConfigKey {})) return (500, 350, 1500);
    let cfg = df::borrow<ConfigKey, RehypoConfig>(institution::uid(inst), ConfigKey {});
    (cfg.init_margin_bps, cfg.maint_margin_bps, cfg.recall_trigger_bps)
}

/// Keeper/admin pushes a fresh stressed-outflow estimate (O_stress, absolute
/// units) and/or retunes the unconditional reserved-IM floor fraction.
public fun set_liquidity_floor<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    stress_floor: u64,
    phi_bps: u16,
) {
    institution::assert_admin(inst, cap);
    assert!(phi_bps <= BPS_DENOM, errors::e_bad_params());
    ensure_config(inst);
    let cfg = df::borrow_mut<ConfigKey, RehypoConfig>(institution::uid_mut(inst), ConfigKey {});
    cfg.stress_floor = stress_floor;
    cfg.phi_bps = phi_bps;
}

/// The liquidity floor F = max(stress_floor, phi·reserved): liquid treasury may
/// never be deployed below this (defaults apply if config was never installed).
public fun required_floor<C>(inst: &Institution<C>): u64 {
    let (stress, phi) = if (df::exists<ConfigKey>(institution::uid(inst), ConfigKey {})) {
        let cfg = df::borrow<ConfigKey, RehypoConfig>(institution::uid(inst), ConfigKey {});
        (cfg.stress_floor, cfg.phi_bps)
    } else (0, 2500);
    let phi_floor = ((institution::reserved_of(inst) as u128) * (phi as u128) / (BPS_DENOM as u128) as u64);
    if (stress > phi_floor) stress else phi_floor
}

/// Liquid funds deployable without breaching the floor.
public fun deployable<C>(inst: &Institution<C>): u64 {
    let t = institution::total(inst);
    let f = required_floor(inst);
    if (t <= f) 0 else t - f
}

/// Principal currently rehypothecated to a single venue (0 if none).
public fun principal_of<C>(inst: &Institution<C>, venue: u8): u64 {
    if (!df::exists<PrincipalKey>(institution::uid(inst), PrincipalKey { venue })) return 0;
    *df::borrow<PrincipalKey, u64>(institution::uid(inst), PrincipalKey { venue })
}

fun is_enabled<C>(inst: &Institution<C>, venue: u8): (bool, u64) {
    if (!df::exists<ConfigKey>(institution::uid(inst), ConfigKey {})) return (true, 0);
    let cfg = df::borrow<ConfigKey, RehypoConfig>(institution::uid(inst), ConfigKey {});
    let mut i = 0;
    let n = vector::length(&cfg.venues);
    while (i < n) {
        let v = vector::borrow(&cfg.venues, i);
        if (v.venue == venue) return (v.enabled, v.cap);
        i = i + 1;
    };
    (true, 0)
}

// ===================================================================
// Hot-potato supply / recall — the safe public seam for adapters.
// ===================================================================

/// Forces the deposit leg to complete: has no abilities, so it can only be
/// destroyed by `confirm_rehypo` in the SAME transaction.
public struct RehypoTicket {
    inst_id: ID,
    venue: u8,
    amount: u64,
}

/// Forces the recall leg to return funds: destroyed only by `finish_recall`.
public struct RecallTicket {
    inst_id: ID,
    venue: u8,
}

/// Admin debits `amount` of physically-liquid treasury for rehypothecation into
/// `venue`. Hands the caller the `Coin<C>` to deposit and a ticket that the same
/// PTB must redeem via `confirm_rehypo`. Accounting (`note_supplied`) lands on
/// confirm, so a PTB that fails to deposit-and-store reverts entirely.
public fun withdraw_for_rehypo<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    venue: u8,
    amount: u64,
    ctx: &mut TxContext,
): (Coin<C>, RehypoTicket) {
    institution::assert_admin(inst, cap);
    assert!(venue <= NAVI, errors::e_bad_params());
    assert!(amount > 0, errors::e_zero_amount());
    assert!(amount <= institution::total(inst), errors::e_insufficient_liquidity());
    // §2 invariant T ≥ F: a deploy may never leave liquid treasury below the
    // risk floor, whatever the keeper proposed.
    assert!(
        institution::total(inst) - amount >= required_floor(inst),
        errors::e_below_liquidity_floor(),
    );
    let (enabled, venue_cap) = is_enabled(inst, venue);
    assert!(enabled, errors::e_bad_params());
    if (venue_cap > 0) {
        assert!(principal_of(inst, venue) + amount <= venue_cap, errors::e_over_book_size());
    };
    let inst_id = object::id(inst);
    let coin = coin::take(institution::treasury_mut(inst), amount, ctx);
    (coin, RehypoTicket { inst_id, venue, amount })
}

/// Stores the venue receipt (generic — DeepBook SupplierCap / Suilend CToken /
/// Navi AccountCap) under the venue's dynamic-field slot, records principal, and
/// credits the `rehypothecated` mirror. Consumes the ticket (proves the deposit
/// leg ran). A venue may produce one receipt object that is re-used across tops-ups
/// (e.g. a SupplierCap/AccountCap already exists) — in that case the adapter passes
/// `option::none()` and only principal is added.
public fun confirm_rehypo<C, R: store>(
    inst: &mut Institution<C>,
    ticket: RehypoTicket,
    receipt: Option<R>,
    ctx: &mut TxContext,
) {
    let RehypoTicket { inst_id, venue, amount } = ticket;
    assert!(inst_id == object::id(inst), errors::e_wrong_institution());
    if (option::is_some(&receipt)) {
        // first deposit for this venue: stash the lender handle
        df::add(institution::uid_mut(inst), ReceiptKey { venue }, option::destroy_some(receipt));
    } else {
        option::destroy_none(receipt);
    };
    add_principal(inst, venue, amount);
    institution::note_supplied(inst, amount, ctx);
}

/// Removes and hands out the venue receipt so the adapter can redeem against it,
/// plus a ticket the same PTB must close with `finish_recall`. Use when the recall
/// consumes the receipt object (e.g. burning Suilend CTokens).
public fun begin_recall<C, R: store>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    venue: u8,
): (R, RecallTicket) {
    institution::assert_admin(inst, cap);
    let receipt = df::remove<ReceiptKey, R>(institution::uid_mut(inst), ReceiptKey { venue });
    (receipt, RecallTicket { inst_id: object::id(inst), venue })
}

/// Borrows the venue receipt by reference (for venues whose recall keeps the same
/// lender handle, e.g. DeepBook SupplierCap / Navi AccountCap). Pair with
/// `finish_recall` to return funds + account.
public fun begin_recall_ref<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    venue: u8,
): RecallTicket {
    institution::assert_admin(inst, cap);
    RecallTicket { inst_id: object::id(inst), venue }
}

/// Read-only borrow of a stored receipt (used by `begin_recall_ref` adapters).
public fun borrow_receipt<C, R: store>(inst: &Institution<C>, venue: u8): &R {
    df::borrow<ReceiptKey, R>(institution::uid(inst), ReceiptKey { venue })
}

/// Returns recalled `Coin<C>` to the treasury and debits the `rehypothecated`
/// mirror by the recalled principal. Any redeemed interest above principal stays
/// in the treasury as realised equity. Consumes the recall ticket.
public fun finish_recall<C>(
    inst: &mut Institution<C>,
    ticket: RecallTicket,
    coin: Coin<C>,
    ctx: &mut TxContext,
) {
    let RecallTicket { inst_id, venue } = ticket;
    assert!(inst_id == object::id(inst), errors::e_wrong_institution());
    let got = coin::value(&coin);
    coin::put(institution::treasury_mut(inst), coin);
    // principal recalled = min(stored principal, what we pulled). Reduce the venue
    // slot and the global mirror by that, leaving interest as equity.
    let principal = principal_of(inst, venue);
    let noted = if (got >= principal) principal else got;
    sub_principal(inst, venue, noted);
    institution::note_recalled(inst, noted, ctx);
}

// ---- internal principal bookkeeping (per-venue dynamic field) ----

fun add_principal<C>(inst: &mut Institution<C>, venue: u8, amount: u64) {
    if (df::exists<PrincipalKey>(institution::uid(inst), PrincipalKey { venue })) {
        let p = df::borrow_mut<PrincipalKey, u64>(
            institution::uid_mut(inst),
            PrincipalKey { venue },
        );
        *p = *p + amount;
    } else {
        df::add(institution::uid_mut(inst), PrincipalKey { venue }, amount);
    }
}

fun sub_principal<C>(inst: &mut Institution<C>, venue: u8, amount: u64) {
    let p = df::borrow_mut<PrincipalKey, u64>(institution::uid_mut(inst), PrincipalKey { venue });
    *p = if (amount >= *p) 0 else *p - amount;
}
