/// Rehypothecation: supply an institution's idle collateral into DeepBook's
/// margin (lending) pool to earn yield, and recall it on demand — including
/// permissionlessly when the risk oracle latches a trigger.
///
/// The institution IS the lender: its DeepBook `SupplierCap` is stashed as a
/// dynamic field on the institution object (verified pattern — supply/withdraw
/// take `&SupplierCap` with no sender check, so a shared object can hold it).
/// Funds are split out of the one treasury `Balance<C>` on supply and joined
/// back on recall; `note_supplied`/`note_recalled` keep the `rehypothecated`
/// mirror so `equity()` still counts funds that are out earning yield.
module fullmetal::rehypo;

use std::string::String;
use sui::clock::Clock;
use sui::coin;
use sui::dynamic_field as df;
use sui::event;
use deepbook_margin::margin_pool::{Self, MarginPool, SupplierCap};
use deepbook_margin::margin_registry::MarginRegistry;
use fullmetal::errors;
use fullmetal::institution::{Self, Institution, AdminCap};
use fullmetal::oracle::{Self, RiskOracle};

/// Dynamic-field key under which the institution's SupplierCap lives.
public struct SupplierCapKey has copy, drop, store {}

public struct Rehypothecated has copy, drop { institution_id: ID, amount: u64, by: address }
public struct Recalled has copy, drop {
    institution_id: ID,
    amount: u64,
    triggered: bool,
    by: address,
}

/// Admin supplies `amount` of liquid collateral into the margin pool. Mints the
/// institution's SupplierCap on first use. `amount` must be physically liquid
/// (not already supplied) — equity/available are unchanged (funds move from
/// liquid to earning), only `total()` (liquid balance) drops.
public fun rehypothecate<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    pool: &mut MarginPool<C>,
    registry: &MarginRegistry,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    institution::assert_admin(inst, cap);
    assert!(amount > 0, errors::e_zero_amount());
    assert!(amount <= institution::total(inst), errors::e_insufficient_liquidity());
    ensure_cap(inst, registry, clock, ctx);

    let coin = coin::take(institution::treasury_mut(inst), amount, ctx);
    {
        let cap_ref = df::borrow<SupplierCapKey, SupplierCap>(
            institution::uid(inst),
            SupplierCapKey {},
        );
        let _shares = margin_pool::supply<C>(pool, registry, cap_ref, coin, option::none(), clock);
    };
    institution::note_supplied(inst, amount, ctx);
    event::emit(Rehypothecated { institution_id: object::id(inst), amount, by: ctx.sender() });
}

/// Admin recalls `amount` of supplied collateral back to the liquid treasury.
public fun recall<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    pool: &mut MarginPool<C>,
    registry: &MarginRegistry,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    institution::assert_admin(inst, cap);
    let got = do_recall(inst, pool, registry, amount, clock, ctx);
    event::emit(Recalled {
        institution_id: object::id(inst),
        amount: got,
        triggered: false,
        by: ctx.sender(),
    });
}

/// Risk-responsive recall — PERMISSIONLESS when the oracle feed has latched a
/// trigger. Pulls ALL currently-rehypothecated collateral back to liquid. This
/// is the headline "collateral auto-deleverages on a volatility spike" path.
public fun recall_on_trigger<C>(
    inst: &mut Institution<C>,
    pool: &mut MarginPool<C>,
    registry: &MarginRegistry,
    oracle: &RiskOracle,
    symbol: String,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(oracle::is_triggered(oracle, symbol), errors::e_trigger_not_active());
    let amount = institution::rehypothecated_of(inst);
    if (amount == 0) return;
    let got = do_recall(inst, pool, registry, amount, clock, ctx);
    event::emit(Recalled {
        institution_id: object::id(inst),
        amount: got,
        triggered: true,
        by: ctx.sender(),
    });
}

/// Live value of the institution's supply position incl. accrued interest
/// (reads DeepBook). The `rehypothecated` mirror tracks principal only, so this
/// is the true "earning" figure for the dashboard.
public fun supplied_value<C>(
    inst: &Institution<C>,
    pool: &MarginPool<C>,
    clock: &Clock,
): u64 {
    let cap_id = institution::rehypo_cap_id(inst);
    if (cap_id.is_none()) return 0;
    margin_pool::user_supply_amount<C>(pool, *cap_id.borrow(), clock)
}

// ---- internal ----

fun do_recall<C>(
    inst: &mut Institution<C>,
    pool: &mut MarginPool<C>,
    registry: &MarginRegistry,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    let principal = institution::rehypothecated_of(inst);
    assert!(amount > 0, errors::e_zero_amount());
    assert!(amount <= principal, errors::e_recall_too_large());

    // DeepBook supply rounds shares DOWN, so the live redeemable value can sit a
    // hair under the recorded principal; asking the pool for the exact principal
    // underflows its share math. So: when recalling the whole position, withdraw
    // ALL (`none` = burn every share); for a partial, clamp to the live value.
    let cap_id = *institution::rehypo_cap_id(inst).borrow();
    let live = margin_pool::user_supply_amount<C>(pool, cap_id, clock);
    let request = if (amount >= live) option::none() else option::some(amount);

    let coin = {
        let cap_ref = df::borrow<SupplierCapKey, SupplierCap>(
            institution::uid(inst),
            SupplierCapKey {},
        );
        margin_pool::withdraw<C>(pool, registry, cap_ref, request, clock, ctx)
    };
    let got = coin::value(&coin);
    coin::put(institution::treasury_mut(inst), coin);
    // Reduce the principal mirror by what we accounted as recalled (capped to the
    // mirror so it never underflows); any rounding dust is realized into equity.
    let noted = if (amount >= principal) principal else amount;
    institution::note_recalled(inst, noted, ctx);
    got
}

fun ensure_cap<C>(
    inst: &mut Institution<C>,
    registry: &MarginRegistry,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    if (!df::exists<SupplierCapKey>(institution::uid(inst), SupplierCapKey {})) {
        let cap = margin_pool::mint_supplier_cap(registry, clock, ctx);
        let cap_id = object::id(&cap);
        df::add(institution::uid_mut(inst), SupplierCapKey {}, cap);
        institution::set_rehypo_cap_id(inst, cap_id, ctx);
    }
}
