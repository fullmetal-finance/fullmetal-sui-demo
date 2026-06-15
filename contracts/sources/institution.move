/// One shared `Institution` object per tenant. It IS the central collateral
/// pool: all funds live in a single `treasury: Balance<C>`. Initial margin is
/// RESERVED (an accounting overlay), never moved out of the pool, so
/// `available = treasury - reserved` and encumbered margin can never be
/// withdrawn. Holds per-trader capital allocations ("book size"), the
/// cross-margin requirement table, multi-admin governance, and the witness-
/// gated seams the later OTC/rehypothecation modules call.
///
/// Generic over collateral `C` (phantom — `Balance<C>`/`Coin<C>` use C only in
/// phantom position) so this package stays framework-only; DBUSDC appears only
/// as a PTB type-argument at call time.
module fullmetal::institution;

use std::ascii;
use std::string::String;
use std::type_name;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};
use fullmetal::errors;
use fullmetal::events;
use fullmetal::protocol::{Self, OtcAllowlist};
use fullmetal::registry::{Self, HandleRegistry};

/// ONE shared object per institution. key-only: cannot be wrapped or stolen.
public struct Institution<phantom C> has key {
    id: UID,
    handle: String, // mirror of the registry handle (display/audit)
    suins_name: Option<String>, // optional vanity .sui, display only, never authority
    paused: bool, // pause switch: blocks all fund movement

    // ----- TREASURY (central collateral pool) -----
    treasury: Balance<C>, // the actual funds (free + reserved, one pool)
    reserved: u64, // encumbered = Σ ContractRef.im_reserved
    total_required: u64, // Σ ContractRef.maintenance_required (cross-margin denominator)
    // amount supplied into DeepBook; funds are split OUT of `treasury` on
    // supply, so this is a pure informational mirror — NOT added to available().
    rehypothecated: u64,

    // ----- TRADERS -----
    traders: Table<address, TraderInfo>,
    live_trader_caps: VecSet<ID>, // precise per-cap revocation set
    cap_epoch: u64, // O(1) mass-revoke counter for trader caps

    // ----- ADMIN GOVERNANCE -----
    admins: AdminRegistry,

    // ----- CROSS-MARGIN seam (built now, populated by OTC later) -----
    contracts: Table<ID, ContractRef>,

    // ----- REHYPOTHECATION seam (placeholder ID until the DeepBook milestone) -----
    rehypo_cap: Option<ID>,
}

/// Inlined multi-admin governance state (a field, not an object).
public struct AdminRegistry has store {
    live_admin_caps: VecSet<ID>,
    admin_count: u64, // invariant: must stay >= 1
    pending_admin: Option<address>, // two-step transfer target
}

/// Founding/added admin authority. key+store => transferable to an admin wallet.
public struct AdminCap has key, store {
    id: UID,
    institution_id: ID,
}

/// Trader authority. key+store => transferable to a trader wallet.
public struct TraderCap has key, store {
    id: UID,
    institution_id: ID,
    trader: address,
    cap_epoch: u64, // snapshot of inst.cap_epoch at mint (epoch revocation)
}

/// Per-trader record (value in the `traders` table).
public struct TraderInfo has store {
    book_size: u64, // max treasury this trader may encumber
    deployed: u64, // currently encumbered by this trader (Σ open IM)
    withdraw_permission: bool, // admin-granted withdraw right (distinct from trading)
    active: bool, // false after revoke
    cap_id: ID, // the live TraderCap bound to this trader
}

/// Per-contract requirement record (value in the `contracts` table) — the
/// cross-margin seam. `witness` records which OTC package reserved it, so only
/// that same package can release it.
public struct ContractRef has store {
    trader: address,
    counterparty: ID,
    im_reserved: u64,
    maintenance_required: u64,
    open: bool,
    witness: ascii::String,
}

// ===================================================================
// Guards
// ===================================================================

fun assert_admin<C>(inst: &Institution<C>, cap: &AdminCap) {
    assert!(object::id(inst) == cap.institution_id, errors::e_wrong_institution());
    assert!(
        vec_set::contains(&inst.admins.live_admin_caps, &object::id(cap)),
        errors::e_admin_revoked(),
    );
}

fun assert_trader<C>(inst: &Institution<C>, cap: &TraderCap) {
    assert!(object::id(inst) == cap.institution_id, errors::e_wrong_institution());
    assert!(vec_set::contains(&inst.live_trader_caps, &object::id(cap)), errors::e_cap_revoked());
    assert!(cap.cap_epoch == inst.cap_epoch, errors::e_cap_revoked());
    assert!(table::contains(&inst.traders, cap.trader), errors::e_cap_revoked());
    let info = table::borrow(&inst.traders, cap.trader);
    assert!(info.active, errors::e_not_active());
    assert!(info.cap_id == object::id(cap), errors::e_cap_revoked());
}

/// public(package) so `settlement` can gate on it.
public(package) fun assert_not_paused<C>(inst: &Institution<C>) {
    assert!(!inst.paused, errors::e_paused());
}

// ===================================================================
// Creation
// ===================================================================

/// Permissionless for the demo. Returns the founding `AdminCap` for the caller
/// to `public_transfer` to the founding admin in the same PTB (it has no `drop`,
/// so the PTB must consume it). To gate creation later, add `_cap: &ProtocolCap`.
public fun create_institution<C>(
    reg: &mut HandleRegistry,
    handle: String,
    ctx: &mut TxContext,
): AdminCap {
    let inst = Institution<C> {
        id: object::new(ctx),
        handle,
        suins_name: option::none(),
        paused: false,
        treasury: balance::zero<C>(),
        reserved: 0,
        total_required: 0,
        rehypothecated: 0,
        traders: table::new(ctx),
        live_trader_caps: vec_set::empty(),
        cap_epoch: 0,
        admins: AdminRegistry {
            live_admin_caps: vec_set::empty(),
            admin_count: 1,
            pending_admin: option::none(),
        },
        contracts: table::new(ctx),
        rehypo_cap: option::none(),
    };
    // capture id BEFORE share/move; mint the founding cap and register the handle.
    let inst_id = object::id(&inst);
    let admin_cap = AdminCap { id: object::new(ctx), institution_id: inst_id };
    let admin_cap_id = object::id(&admin_cap);

    let mut inst = inst;
    vec_set::insert(&mut inst.admins.live_admin_caps, admin_cap_id);
    // String is copyable, so the handle is registered and emitted without moving it.
    registry::insert(reg, inst.handle, inst_id);
    events::emit_institution_created(
        inst_id,
        inst.handle,
        ctx.sender(),
        admin_cap_id,
        ctx.sender(),
    );
    transfer::share_object(inst);
    admin_cap
}

// ===================================================================
// Admin governance
// ===================================================================

public fun add_admin<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    ctx: &mut TxContext,
): AdminCap {
    assert_admin(inst, cap);
    let new_cap = AdminCap { id: object::new(ctx), institution_id: object::id(inst) };
    let new_id = object::id(&new_cap);
    vec_set::insert(&mut inst.admins.live_admin_caps, new_id);
    inst.admins.admin_count = inst.admins.admin_count + 1;
    events::emit_admin_added(object::id(inst), new_id, ctx.sender());
    new_cap
}

/// Revoke an admin cap by id (self-resign or revoke a peer). The cap object stays
/// in its wallet but `assert_admin` then fails for it. An `admin_count >= 1`
/// floor prevents bricking. NOTE: any single admin is fully trusted — it can
/// revoke peers down to itself; size the admin set and key custody accordingly.
public fun revoke_admin<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    target_cap_id: ID,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    assert!(inst.admins.admin_count > 1, errors::e_cannot_remove_last_admin());
    assert!(
        vec_set::contains(&inst.admins.live_admin_caps, &target_cap_id),
        errors::e_admin_revoked(),
    );
    vec_set::remove(&mut inst.admins.live_admin_caps, &target_cap_id);
    inst.admins.admin_count = inst.admins.admin_count - 1;
    events::emit_admin_revoked(object::id(inst), target_cap_id, ctx.sender());
}

/// Two-step admin onboarding (proposal grants no power). Must be empty to propose;
/// `cancel_admin_transfer` clears a stale proposal. `accept` ADDS an admin.
public fun propose_admin_transfer<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    new_admin: address,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    assert!(inst.admins.pending_admin.is_none(), errors::e_admin_transfer_pending());
    inst.admins.pending_admin = option::some(new_admin);
    events::emit_admin_transfer_proposed(object::id(inst), new_admin, ctx.sender());
}

public fun accept_admin_transfer<C>(
    inst: &mut Institution<C>,
    ctx: &mut TxContext,
): AdminCap {
    assert!(
        inst.admins.pending_admin.is_some()
            && *inst.admins.pending_admin.borrow() == ctx.sender(),
        errors::e_not_proposed_admin(),
    );
    let new_cap = AdminCap { id: object::new(ctx), institution_id: object::id(inst) };
    let new_id = object::id(&new_cap);
    vec_set::insert(&mut inst.admins.live_admin_caps, new_id);
    inst.admins.admin_count = inst.admins.admin_count + 1;
    inst.admins.pending_admin = option::none();
    events::emit_admin_transfer_accepted(object::id(inst), ctx.sender(), new_id);
    new_cap
}

public fun cancel_admin_transfer<C>(inst: &mut Institution<C>, cap: &AdminCap) {
    assert_admin(inst, cap);
    inst.admins.pending_admin = option::none();
}

// ===================================================================
// Pause
// ===================================================================

public fun pause<C>(inst: &mut Institution<C>, cap: &AdminCap, ctx: &mut TxContext) {
    assert_admin(inst, cap);
    assert!(!inst.paused, errors::e_already_paused());
    inst.paused = true;
    events::emit_paused(object::id(inst), ctx.sender());
}

public fun unpause<C>(inst: &mut Institution<C>, cap: &AdminCap, ctx: &mut TxContext) {
    assert_admin(inst, cap);
    assert!(inst.paused, errors::e_not_paused());
    inst.paused = false;
    events::emit_unpaused(object::id(inst), ctx.sender());
}

// ===================================================================
// Treasury
// ===================================================================

public fun deposit_treasury<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    c: Coin<C>,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    assert_not_paused(inst);
    assert!(coin::value(&c) > 0, errors::e_zero_amount());
    let amount = coin::value(&c);
    coin::put(&mut inst.treasury, c);
    events::emit_treasury_deposited(
        object::id(inst),
        amount,
        balance::value(&inst.treasury),
        ctx.sender(),
    );
}

/// Withdraw only free (unencumbered) funds — `amount <= available` keeps the
/// `total >= reserved` invariant. Returns the Coin for the caller to route.
public fun withdraw_treasury<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<C> {
    assert_admin(inst, cap);
    assert_not_paused(inst);
    assert!(amount > 0, errors::e_zero_amount());
    assert!(amount <= available(inst), errors::e_would_underfund_reserved());
    let c = coin::take(&mut inst.treasury, amount, ctx);
    events::emit_treasury_withdrawn(
        object::id(inst),
        amount,
        balance::value(&inst.treasury),
        available(inst),
        ctx.sender(),
    );
    c
}

/// Free, unencumbered funds. Saturating: never aborts even if a future
/// rehypothecation milestone lets physical balance dip below `reserved`.
public fun available<C>(inst: &Institution<C>): u64 {
    let bal = balance::value(&inst.treasury);
    if (bal <= inst.reserved) 0 else bal - inst.reserved
}

public fun total<C>(inst: &Institution<C>): u64 { balance::value(&inst.treasury) }

public fun reserved_of<C>(inst: &Institution<C>): u64 { inst.reserved }

public fun total_required_of<C>(inst: &Institution<C>): u64 { inst.total_required }

public fun rehypothecated_of<C>(inst: &Institution<C>): u64 { inst.rehypothecated }

/// 1-day shortfall flag for the dashboard: would the free pool fail to cover a
/// payment due within the day?
public fun would_shortfall<C>(inst: &Institution<C>, due_within_day: u64): bool {
    available(inst) < due_within_day
}

public fun handle<C>(inst: &Institution<C>): String { inst.handle }

public fun is_paused<C>(inst: &Institution<C>): bool { inst.paused }

/// Which institution an AdminCap governs (handy for frontend lookups).
public fun admin_institution_id(cap: &AdminCap): ID { cap.institution_id }

/// Which institution a TraderCap governs, and the address it authorizes.
public fun trader_institution_id(cap: &TraderCap): ID { cap.institution_id }

public fun trader_of_cap(cap: &TraderCap): address { cap.trader }

// ===================================================================
// Traders, book size, revocation
// ===================================================================

public fun grant_trader<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    trader: address,
    book_size: u64,
    ctx: &mut TxContext,
): TraderCap {
    assert_admin(inst, cap);
    assert!(!table::contains(&inst.traders, trader), errors::e_trader_exists());
    let tcap = TraderCap {
        id: object::new(ctx),
        institution_id: object::id(inst),
        trader,
        cap_epoch: inst.cap_epoch,
    };
    let cap_id = object::id(&tcap);
    vec_set::insert(&mut inst.live_trader_caps, cap_id);
    table::add(
        &mut inst.traders,
        trader,
        TraderInfo { book_size, deployed: 0, withdraw_permission: false, active: true, cap_id },
    );
    events::emit_trader_granted(object::id(inst), trader, cap_id, book_size, ctx.sender());
    tcap
}

/// Marks the trader inactive and drops their cap from the live set. Does NOT
/// touch `deployed` — open positions stay open and must be closed via
/// `release_margin` (callable even for revoked traders).
public fun revoke_trader<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    trader: address,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    assert!(table::contains(&inst.traders, trader), errors::e_no_such_trader());
    let (cap_id, freed) = {
        let info = table::borrow_mut(&mut inst.traders, trader);
        info.active = false;
        (info.cap_id, info.deployed)
    };
    if (vec_set::contains(&inst.live_trader_caps, &cap_id)) {
        vec_set::remove(&mut inst.live_trader_caps, &cap_id);
    };
    events::emit_trader_revoked(object::id(inst), trader, cap_id, freed, ctx.sender());
}

public fun set_book_size<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    trader: address,
    new_size: u64,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    assert!(table::contains(&inst.traders, trader), errors::e_no_such_trader());
    let old_size = {
        let info = table::borrow_mut(&mut inst.traders, trader);
        assert!(new_size >= info.deployed, errors::e_cannot_shrink_below_deployed());
        let o = info.book_size;
        info.book_size = new_size;
        o
    };
    events::emit_book_size_changed(object::id(inst), trader, old_size, new_size, ctx.sender());
}

public fun set_withdraw_permission<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    trader: address,
    allowed: bool,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    assert!(table::contains(&inst.traders, trader), errors::e_no_such_trader());
    {
        let info = table::borrow_mut(&mut inst.traders, trader);
        info.withdraw_permission = allowed;
    };
    events::emit_withdraw_perm_set(object::id(inst), trader, allowed, ctx.sender());
}

/// O(1) mass-revoke: every existing TraderCap fails the epoch check after this.
public fun bump_cap_epoch<C>(inst: &mut Institution<C>, cap: &AdminCap, ctx: &mut TxContext) {
    assert_admin(inst, cap);
    inst.cap_epoch = inst.cap_epoch + 1;
    events::emit_cap_epoch_bumped(object::id(inst), inst.cap_epoch, ctx.sender());
}

public fun set_suins_name<C>(
    inst: &mut Institution<C>,
    cap: &AdminCap,
    name: Option<String>,
    ctx: &mut TxContext,
) {
    assert_admin(inst, cap);
    inst.suins_name = name;
    events::emit_suins_name_set(object::id(inst), inst.suins_name, ctx.sender());
}

public fun trader_view<C>(inst: &Institution<C>, trader: address): (u64, u64, bool, bool) {
    assert!(table::contains(&inst.traders, trader), errors::e_no_such_trader());
    let info = table::borrow(&inst.traders, trader);
    (info.book_size, info.deployed, info.withdraw_permission, info.active)
}

/// Pre-trade headroom: how much more this trader may still deploy.
public fun trader_remaining<C>(inst: &Institution<C>, trader: address): u64 {
    assert!(table::contains(&inst.traders, trader), errors::e_no_such_trader());
    let info = table::borrow(&inst.traders, trader);
    info.book_size - info.deployed
}

// ===================================================================
// OTC margin seams (called cross-package by the OTC module later)
// ===================================================================

// `get_with_original_ids` is the original-ids (upgrade-stable) accessor on Sui
// 1.72.x; the rename to `with_original_ids` only lands in a later framework.
//
/// Reserve initial margin for a new contract, within the trader's book size and
/// firm liquidity. Funds do NOT move — IM is fenced in the pool via `reserved`.
/// Auth = the OTC module's `drop` witness `W` (allowlisted by ProtocolCap) PLUS
/// the trader's own cap (re-runs the full revocation/epoch/active check). The
/// witness type-name is recorded so only the same OTC package can release it.
#[allow(deprecated_usage)]
public fun reserve_margin<C, W: drop>(
    inst: &mut Institution<C>,
    _w: W,
    allow: &OtcAllowlist,
    trader_cap: &TraderCap,
    otc_id: ID,
    counterparty: ID,
    im_amount: u64,
    maintenance: u64,
) {
    assert_not_paused(inst);
    assert_trader(inst, trader_cap);
    let wname = type_name::get_with_original_ids<W>().into_string();
    assert!(protocol::is_witness_allowed(allow, &wname), errors::e_witness_not_allowed());
    assert!(!table::contains(&inst.contracts, otc_id), errors::e_contract_exists());

    let trader = trader_cap.trader;
    let (deployed, book_size) = {
        let info = table::borrow(&inst.traders, trader);
        (info.deployed, info.book_size)
    };
    assert!(deployed + im_amount <= book_size, errors::e_over_book_size());
    assert!(im_amount <= available(inst), errors::e_insufficient_treasury());

    {
        let info = table::borrow_mut(&mut inst.traders, trader);
        info.deployed = info.deployed + im_amount;
    };
    inst.reserved = inst.reserved + im_amount;
    inst.total_required = inst.total_required + maintenance;
    table::add(
        &mut inst.contracts,
        otc_id,
        ContractRef {
            trader,
            counterparty,
            im_reserved: im_amount,
            maintenance_required: maintenance,
            open: true,
            witness: wname,
        },
    );
    events::emit_margin_reserved(object::id(inst), otc_id, trader, counterparty, im_amount);
}

/// Reverse a reservation on close/termination. Pause-exempt and active-exempt so
/// positions can always be unwound. Only the OTC package that reserved the
/// contract (matching witness) may release it.
#[allow(deprecated_usage)]
public fun release_margin<C, W: drop>(
    inst: &mut Institution<C>,
    _w: W,
    allow: &OtcAllowlist,
    otc_id: ID,
) {
    let wname = type_name::get_with_original_ids<W>().into_string();
    assert!(protocol::is_witness_allowed(allow, &wname), errors::e_witness_not_allowed());
    assert!(table::contains(&inst.contracts, otc_id), errors::e_no_contract());

    let (rtrader, im, maint, is_open, rwitness) = {
        let r = table::borrow(&inst.contracts, otc_id);
        (r.trader, r.im_reserved, r.maintenance_required, r.open, r.witness)
    };
    assert!(is_open, errors::e_no_contract());
    assert!(rwitness == wname, errors::e_witness_not_allowed());
    assert!(im <= inst.reserved, errors::e_recall_too_large());
    assert!(maint <= inst.total_required, errors::e_recall_too_large());

    {
        let info = table::borrow_mut(&mut inst.traders, rtrader);
        assert!(im <= info.deployed, errors::e_recall_too_large());
        info.deployed = info.deployed - im;
    };
    inst.reserved = inst.reserved - im;
    inst.total_required = inst.total_required - maint;
    {
        let r = table::borrow_mut(&mut inst.contracts, otc_id);
        r.open = false;
    };
    events::emit_margin_released(object::id(inst), otc_id, rtrader, im);
}

/// Read a contract record for the dashboard: (trader, counterparty, im_reserved,
/// maintenance_required, open).
public fun contract_view<C>(
    inst: &Institution<C>,
    otc_id: ID,
): (address, ID, u64, u64, bool) {
    assert!(table::contains(&inst.contracts, otc_id), errors::e_no_contract());
    let r = table::borrow(&inst.contracts, otc_id);
    (r.trader, r.counterparty, r.im_reserved, r.maintenance_required, r.open)
}

// ===================================================================
// Rehypothecation accessors (same-package, for the future rehypo module)
// ===================================================================

public(package) fun set_rehypo_cap_id<C>(
    inst: &mut Institution<C>,
    cap_id: ID,
    ctx: &TxContext,
) {
    inst.rehypo_cap = option::some(cap_id);
    events::emit_rehypo_cap_set(object::id(inst), cap_id, ctx.sender());
}

public(package) fun rehypo_cap_id<C>(inst: &Institution<C>): Option<ID> { inst.rehypo_cap }

public(package) fun note_supplied<C>(
    inst: &mut Institution<C>,
    amount: u64,
    ctx: &TxContext,
) {
    inst.rehypothecated = inst.rehypothecated + amount;
    events::emit_rehypo_supplied(object::id(inst), amount, inst.rehypothecated, ctx.sender());
}

public(package) fun note_recalled<C>(
    inst: &mut Institution<C>,
    amount: u64,
    ctx: &TxContext,
) {
    assert!(amount <= inst.rehypothecated, errors::e_recall_too_large());
    inst.rehypothecated = inst.rehypothecated - amount;
    events::emit_rehypo_recalled(object::id(inst), amount, inst.rehypothecated, ctx.sender());
}

/// Mutable treasury handle so the same-package rehypo and settlement modules can
/// split funds out / join funds back.
public(package) fun treasury_mut<C>(inst: &mut Institution<C>): &mut Balance<C> {
    &mut inst.treasury
}
