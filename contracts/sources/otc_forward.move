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
use sui::dynamic_field as df;
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
/// Margin-call cure window: an insolvent MM breach must persist this long —
/// uncured by deposit, venue recall, or mean-reversion — before it may be
/// liquidated (anti wick-picking; see `settle_on_breach`). Production target
/// is ~10 minutes; set to 90s for the demo so a live margin-call → cure /
/// liquidation drill fits on stage (internal constant, not part of the ABI).
const CURE_WINDOW_MS: u64 = 90_000; // 90 seconds (demo calibration)
const U64_MAX: u128 = 18_446_744_073_709_551_615;

const STATUS_ACTIVE: u8 = 0;
const STATUS_SETTLED: u8 = 1; // closed normally at expiry
const STATUS_LIQUIDATED: u8 = 2;

/// Witness authorizing this module to reserve/release margin and settle between
/// institutions. Must be allowlisted by the ProtocolCap holder at deploy.
public struct OtcWitness has drop {}

/// Witness for the RFQ flow's firm-quote reservations. Defined HERE (not in
/// `rfq`) so `open_from_rfq` can name it without `otc_forward` depending on
/// `rfq` — `rfq` depends on `otc_forward`, never the reverse (no module cycle).
/// Must also be allowlisted by the ProtocolCap holder at deploy.
public struct RfqWitness has drop {}

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

/// Dynamic-field key for a pending margin call (value: the call's ms timestamp).
public struct MarginCallKey has copy, drop, store {}

/// An insolvent MM breach was recorded; the desk has until `deadline_ms` to
/// cure (deposit / recall from venues / mean-reversion) before a still-live
/// breach becomes liquidatable.
public struct MarginCalled has copy, drop {
    otc_id: ID,
    mark: u64,
    owed: u64,
    deadline_ms: u64,
}
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

/// Maintenance for an IM, the single source of truth so RFQ reserves the
/// identical value the lifecycle expects on the re-keyed maker leg.
public(package) fun maintenance_of(im_each: u64): u64 { muldiv(im_each, MAINTENANCE_BPS, 10_000, false) }

/// Package-internal constructor so the `rfq` module can pass an `RfqWitness`
/// value into `reserve_margin`/`release_margin` (struct construction is
/// otc_forward-private). public(package) ⇒ only fullmetal modules can mint it;
/// usability still requires the type-name be allowlisted by the ProtocolCap.
public(package) fun rfq_witness(): RfqWitness { RfqWitness {} }

/// The exact allowlist type-name strings for the two witnesses, so the deploy
/// step can `allow_otc_witness` them without guessing the format.
#[allow(deprecated_usage)]
public fun otc_witness_name(): std::ascii::String {
    std::type_name::get_with_original_ids<OtcWitness>().into_string()
}

#[allow(deprecated_usage)]
public fun rfq_witness_name(): std::ascii::String {
    std::type_name::get_with_original_ids<RfqWitness>().into_string()
}

/// RFQ-only constructor (package-internal; called by `rfq::accept_quote`).
/// Builds + shares an OtcForward identical to `open`'s, but: reserves the
/// REQUESTER leg via `reserve_margin<OtcWitness>` with its LIVE cap, and
/// RE-KEYS the MAKER leg (already firm-reserved under RfqWitness at quote time,
/// keyed by `maker_quote_id`) onto the fresh otc_id under OtcWitness. After
/// this, both legs are OtcWitness-keyed, so the deployed settle/close/
/// liquidation release them unchanged. The maker never co-signs.
public(package) fun open_from_rfq<C>(
    requester_inst: &mut Institution<C>,
    requester_cap: &TraderCap,
    requester_is_long: bool,
    maker_inst: &mut Institution<C>,
    maker_trader: address,
    maker_quote_id: ID,
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
): ID {
    let req_id = object::id(requester_inst);
    let maker_id = object::id(maker_inst);
    assert!(req_id != maker_id, errors::e_not_counterparties());
    assert!(notional > 0, errors::e_zero_notional());
    assert!(entry_price > 0, errors::e_zero_price());

    let maintenance = muldiv(im_each, MAINTENANCE_BPS, 10_000, false);
    let notional_6dp = muldiv(entry_price, notional, PRICE_UNIT, false);
    let now = clock::timestamp_ms(clock);

    // resolve long/short from the requester's chosen side
    let (inst_long, inst_short, trader_long, trader_short) = if (requester_is_long) {
        (req_id, maker_id, institution::trader_of_cap(requester_cap), maker_trader)
    } else {
        (maker_id, req_id, maker_trader, institution::trader_of_cap(requester_cap))
    };

    let fwd = OtcForward<C> {
        id: object::new(ctx),
        inst_long,
        inst_short,
        trader_long,
        trader_short,
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

    // REQUESTER leg: live cap present in the accept PTB
    institution::reserve_margin<C, OtcWitness>(
        requester_inst, OtcWitness {}, allow, requester_cap, otc_id, maker_id, im_each, maintenance,
    );
    // MAKER leg: relabel the firm RfqWitness reservation -> OtcWitness at otc_id
    institution::rekey_reservation<C, RfqWitness, OtcWitness>(
        maker_inst,
        RfqWitness {},
        OtcWitness {},
        allow,
        maker_quote_id,
        otc_id,
        req_id,
        im_each,
        maintenance,
    );

    event::emit(ContractOpened {
        otc_id,
        inst_long,
        inst_short,
        underlying: fwd.underlying,
        notional,
        entry_price,
        im_each,
    });
    transfer::share_object(fwd);
    otc_id
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
    // Past expiry, funding must stop and the contract settles as SETTLED, not
    // LIQUIDATED — `close` is the only correct terminal path. Without this,
    // funding kept accruing post-expiry and a winner could keep cranking
    // `settle` to bill it.
    assert!(!expired(fwd, now), errors::e_expired_use_close());
    assert!(now >= fwd.last_settle_ms + fwd.settlement_interval_ms, errors::e_not_due_yet());
    let mark = oracle::price(oracle, fwd.underlying);
    settle_at_mark(fwd, long_inst, short_inst, allow, mark, now, ctx);
}

fun expired<C>(fwd: &OtcForward<C>, now: u64): bool {
    fwd.expiry_ms > 0 && now >= fwd.expiry_ms
}

/// MM buffer: the unrealized loss a position may carry before anyone can force
/// settlement — the slice of IM above maintenance (im − 0.7·im = 30% of IM).
public fun mm_buffer<C>(fwd: &OtcForward<C>): u64 {
    fwd.im_each - fwd.maintenance_each
}

/// True iff the losing side's unrealized net (VM + funding since `last_mark`)
/// at the current oracle mark exceeds the MM buffer — the keeper's watch
/// predicate, and the gate on `settle_on_breach`.
public fun mm_breached<C>(fwd: &OtcForward<C>, oracle: &RiskOracle, clock: &Clock): bool {
    if (fwd.status != STATUS_ACTIVE) return false;
    if (!oracle::has_feed(oracle, fwd.underlying)) return false;
    let (_, amount) = compute_net(fwd, oracle::price(oracle, fwd.underlying), clock::timestamp_ms(clock));
    amount > mm_buffer(fwd)
}

/// If a margin call is pending on a LIVE contract, the ms timestamp after which
/// a still-uncovered position may be liquidated (for the keeper/UI). Returns
/// none on terminal contracts even if a stale key lingers.
public fun margin_call_deadline<C>(fwd: &OtcForward<C>): Option<u64> {
    if (fwd.status == STATUS_ACTIVE && df::exists_<MarginCallKey>(&fwd.id, MarginCallKey {})) {
        option::some(*df::borrow<MarginCallKey, u64>(&fwd.id, MarginCallKey {}) + CURE_WINDOW_MS)
    } else option::none()
}

fun clear_margin_call<C>(fwd: &mut OtcForward<C>) {
    if (df::exists_<MarginCallKey>(&fwd.id, MarginCallKey {})) {
        df::remove<MarginCallKey, u64>(&mut fwd.id, MarginCallKey {});
    }
}

/// MAINTENANCE-BREACH CRANK — permissionless, no cadence gate. Makes
/// maintenance margin load-bearing and cross-margining real:
///
///  * TEETH: the moment a position's unrealized loss consumes its IM buffer
///    above maintenance, ANYONE may force settlement at the live mark — no
///    waiting for the interval, no admin key at 3am.
///  * GRACE (the cross-margin benefit): a breach does NOT kill the position.
///    If the loser's pooled treasury has the free liquid funds, the payment
///    settles and the position re-marks and SURVIVES.
///  * DUE PROCESS: if free funds are not physically present (insolvent, or
///    still deployed to a venue), the first crank records a MARGIN CALL and the
///    desk gets the cure window to deposit, recall, or let the mark revert;
///    only a call aged past the window — still uncovered — liquidates. A wick
///    that mean-reverts cannot kill a position.
///
/// The pay-vs-call-vs-liquidate decision lives in `settle_at_mark` and is shared
/// with the cadence `settle`, so both honor the cure window (an earlier version
/// let `settle` liquidate insolvency instantly, bypassing it). Firm-level
/// enforcement composes: a keeper watching Σ unrealized across a desk's book
/// cranks every breached contract in one PTB. The firm-CASH analogue
/// (equity < Σ maintenance) is structurally unreachable — payments are capped
/// at `available`, so equity never drops below Σ reserved IM ≥ Σ maintenance;
/// unrealized loss is the only thing that can outrun the fences, and this
/// polices it.
public fun settle_on_breach<C>(
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
    assert!(!expired(fwd, now), errors::e_expired_use_close());
    let mark = oracle::price(oracle, fwd.underlying);
    let (_, amount) = compute_net(fwd, mark, now);
    if (amount <= mm_buffer(fwd)) {
        // Healthy. If a stale margin call from an earlier (now-reverted) breach
        // is lingering, clear it — otherwise a future breach could liquidate off
        // that stale window with no fresh cure period. With no call pending
        // there is nothing to do, so abort to deny pure crank-harassment.
        assert!(df::exists_<MarginCallKey>(&fwd.id, MarginCallKey {}), errors::e_healthy());
        clear_margin_call(fwd);
        return
    };
    // Breached. `settle_at_mark` decides: pay-and-survive if free liquid funds
    // cover, else record/enforce the margin call → liquidate only past the cure
    // window (anti wick-picking).
    settle_at_mark(fwd, long_inst, short_inst, allow, mark, now, ctx);
}

/// Shared pay / margin-call / liquidate core for `settle` (cadence-gated) and
/// `settle_on_breach` (MM-gated). Caller has validated parties, status, feed,
/// expiry, and its own gate.
///
/// "Can pay now" means free funds are PHYSICALLY present: `available` (economic,
/// counts rehypothecated Y) AND `total` (physical liquid) both cover `amount`.
/// A physical shortfall with economic slack means the free funds are out at a
/// venue — the desk must recall (permissionless `recall_on_trigger`, its own
/// recall, or a keeper composing recall+settle) — so it takes the margin-call
/// path rather than aborting settlement or liquidating a solvent desk.
fun settle_at_mark<C>(
    fwd: &mut OtcForward<C>,
    long_inst: &mut Institution<C>,
    short_inst: &mut Institution<C>,
    allow: &OtcAllowlist,
    mark: u64,
    now: u64,
    ctx: &mut TxContext,
) {
    let (short_pays_long, amount) = compute_net(fwd, mark, now);
    let otc_id = object::id(fwd);

    if (amount == 0) {
        clear_margin_call(fwd);
        fwd.last_mark = mark;
        fwd.last_settle_ms = now;
        return
    };

    let can_pay = if (short_pays_long) can_cover(short_inst, amount) else can_cover(long_inst, amount);
    if (can_pay) {
        clear_margin_call(fwd);
        if (short_pays_long) transfer_net(short_inst, long_inst, allow, otc_id, amount, ctx)
        else transfer_net(long_inst, short_inst, allow, otc_id, amount, ctx);
        fwd.last_mark = mark;
        fwd.last_settle_ms = now;
        event::emit(IntervalSettled { otc_id, mark, short_paid_long: short_pays_long, amount, ts_ms: now });
        return
    };

    // Cannot pay from liquid free funds. First observation records a MARGIN CALL
    // and returns; the desk has the cure window to deposit, recall from venues,
    // or let the mark revert. Only a call that has aged past the window — still
    // uncovered — liquidates. This is the anti wick-picking gate, and it now
    // covers BOTH the cadence and breach paths (previously `settle` liquidated
    // insolvency instantly, bypassing it).
    if (!df::exists_<MarginCallKey>(&fwd.id, MarginCallKey {})) {
        df::add(&mut fwd.id, MarginCallKey {}, now);
        event::emit(MarginCalled { otc_id, mark, owed: amount, deadline_ms: now + CURE_WINDOW_MS });
        return
    };
    let called_ms = *df::borrow<MarginCallKey, u64>(&fwd.id, MarginCallKey {});
    assert!(now >= called_ms + CURE_WINDOW_MS, errors::e_cure_window_active());
    let recovered = if (short_pays_long) {
        final_settle(fwd, short_inst, long_inst, allow, amount, STATUS_LIQUIDATED, ctx)
    } else {
        final_settle(fwd, long_inst, short_inst, allow, amount, STATUS_LIQUIDATED, ctx)
    };
    event::emit(ContractLiquidated { otc_id, mark, recovered });
}

/// Free funds physically present to pay `amount`: economic `available` (never
/// touch fenced IM) AND physical `total` (can't hand over funds sitting at a
/// venue) must both cover it.
fun can_cover<C>(payer: &Institution<C>, amount: u64): bool {
    institution::available(payer) >= amount && institution::total(payer) >= amount
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
    let (short_pays_long, amount) = compute_net(fwd, mark, clock::timestamp_ms(clock));
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
fun compute_net<C>(fwd: &OtcForward<C>, mark_1e6: u64, now: u64): (bool, u64) {
    let (vm_mag, long_gains) = pnl_6dp(fwd.last_mark, mark_1e6, fwd.notional);
    // Funding accrues with TIME, not with settlement count: `funding_rate_bps`
    // buys one full interval's funding; a settlement `elapsed` ms after the
    // previous one charges elapsed/interval of it (rounded up). Charging per
    // CALL was a confirmed value leak once `settle_on_breach` existed — the
    // funding recipient could bill one full funding per crank, K per interval.
    // Pro-rata makes any crank sequence telescope to exactly the elapsed-time
    // charge. interval == 0 (settle-anytime) keeps the per-settlement charge.
    // interval == 0 is a settle-ANYTIME forward: there is no funding period to
    // pro-rate over, so it carries NO periodic funding. (Charging a full funding
    // per call there was a value leak — `settle` is callable every block when
    // interval is 0.) A funded perp must set a real interval, e.g. 8h.
    let funding = if (fwd.settlement_interval_ms == 0 || fwd.funding_rate_bps == 0) {
        0
    } else {
        let funding_full = muldiv(fwd.notional_6dp, fwd.funding_rate_bps, 10_000, true);
        let elapsed = if (now > fwd.last_settle_ms) now - fwd.last_settle_ms else 0;
        muldiv(funding_full, elapsed, fwd.settlement_interval_ms, true)
    };

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
    // Pay the winner what the loser physically has, capped at what is owed.
    // `total` (physical liquid), not `available`: releasing the IM fences raised
    // `available`, but only physically-liquid funds can actually be transferred —
    // anything still at a venue stays the loser's (recall it before/within the
    // cure window to avoid short-paying the winner).
    let pay = min(owed, institution::total(payer));
    transfer_net(payer, payee, allow, otc_id, pay, ctx);
    fwd.status = new_status;
    clear_margin_call(fwd);
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
