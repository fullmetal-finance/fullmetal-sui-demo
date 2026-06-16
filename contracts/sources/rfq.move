/// Request-for-quote: an institution posts a request, counterparties respond
/// with FIRM, collateral-backed quotes, and the requester accepts one — which
/// atomically opens the bilateral OtcForward.
///
/// The crux: `otc_forward::open` needs both desks' TraderCaps in one tx, but RFQ
/// is async. Resolution — a maker commits at QUOTE time (it co-signs
/// `submit_quote` with its own cap, firm-reserving its IM under `RfqWitness`
/// keyed by the Quote's id). `accept_quote` is signed by the REQUESTER only: it
/// reserves the requester's leg with the live requester cap and RE-KEYS the
/// maker's existing reservation onto the new contract — no maker co-signature,
/// no maker fade. Deliberately NO last-look (a TradFi FX artifact): a maker
/// pulls a quote via `withdraw_quote`, it can't renege after acceptance.
module fullmetal::rfq;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::vec_set::{Self, VecSet};
use fullmetal::errors;
use fullmetal::events;
use fullmetal::institution::{Self, Institution, TraderCap};
use fullmetal::otc_forward::{Self, RfqWitness};
use fullmetal::protocol::OtcAllowlist;

const RFQ_OPEN: u8 = 0;
const RFQ_FILLED: u8 = 1;
const RFQ_CANCELLED: u8 = 2;

const QUOTE_LIVE: u8 = 0;
const QUOTE_WITHDRAWN: u8 = 1;
const QUOTE_ACCEPTED: u8 = 2;
const QUOTE_RECLAIMED: u8 = 3;

const SIDE_REQUESTER_LONG: u8 = 0; // requester is long; maker is short
const SIDE_REQUESTER_SHORT: u8 = 1;

/// The request intent — shared for discoverability + audit. No margin is locked
/// at open; the requester commits only when it accepts. Carries `otc_forward`'s
/// economic template minus price (price is what makers compete on).
public struct Rfq<phantom C> has key {
    id: UID,
    requester_inst: ID,
    requester_trader: address,
    targets: VecSet<ID>, // allowed maker Institution IDs; empty = broadcast
    requester_side: u8,
    underlying: String,
    notional: u64,
    im_each: u64,
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    contract_expiry_ms: u64,
    min_price: u64, // 1e6; 0 = no floor
    max_price: u64, // 1e6; 0 = no cap
    status: u8,
    rfq_expiry_ms: u64,
    accepted_quote: Option<ID>,
}

/// A maker's firm, collateral-backed offer — its OWN shared object so makers
/// quote in parallel (no contention on the Rfq). The teeth are a ContractRef in
/// the maker's Institution keyed by `object::id(this)`, reserved under
/// RfqWitness; `reserved_im` mirrors it for display.
public struct Quote<phantom C> has key {
    id: UID,
    rfq_id: ID,
    maker_inst: ID,
    maker_trader: address,
    maker_cap_id: ID,
    entry_price: u64,
    im_each: u64,
    maintenance_each: u64,
    quote_expiry_ms: u64,
    status: u8,
    reserved_im: u64,
}

/// Requester publishes intent. No margin reserved (commits at accept).
public fun open_rfq<C>(
    requester_inst: &Institution<C>,
    requester_cap: &TraderCap,
    targets: vector<ID>,
    requester_side: u8,
    underlying: String,
    notional: u64,
    im_each: u64,
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    contract_expiry_ms: u64,
    min_price: u64,
    max_price: u64,
    rfq_ttl_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    institution::assert_not_paused(requester_inst);
    institution::assert_trader_external(requester_inst, requester_cap);
    assert!(requester_side <= SIDE_REQUESTER_SHORT, errors::e_bad_params());
    assert!(notional > 0, errors::e_zero_notional());
    assert!(im_each > 0, errors::e_zero_amount());
    assert!(rfq_ttl_ms > 0, errors::e_bad_params());
    if (min_price > 0 && max_price > 0) {
        assert!(min_price <= max_price, errors::e_bad_params());
    };

    let mut tset = vec_set::empty<ID>();
    let mut i = 0;
    let n = targets.length();
    while (i < n) {
        let t = *targets.borrow(i);
        if (!vec_set::contains(&tset, &t)) vec_set::insert(&mut tset, t);
        i = i + 1;
    };
    let targets_len = vec_set::size(&tset);
    let now = clock::timestamp_ms(clock);

    let rfq = Rfq<C> {
        id: object::new(ctx),
        requester_inst: object::id(requester_inst),
        requester_trader: institution::trader_of_cap(requester_cap),
        targets: tset,
        requester_side,
        underlying,
        notional,
        im_each,
        funding_rate_bps,
        funding_long_pays,
        settlement_interval_ms,
        contract_expiry_ms,
        min_price,
        max_price,
        status: RFQ_OPEN,
        rfq_expiry_ms: now + rfq_ttl_ms,
        accepted_quote: option::none(),
    };
    let rfq_id = object::id(&rfq);
    events::emit_rfq_opened(
        rfq_id,
        rfq.requester_inst,
        rfq.requester_trader,
        requester_side,
        rfq.underlying,
        notional,
        im_each,
        targets_len,
        rfq.rfq_expiry_ms,
        ctx.sender(),
    );
    transfer::share_object(rfq);
    rfq_id
}

/// Maker posts a firm, collateral-backed quote. Reads the Rfq (no mutation, so
/// makers quote in parallel) and firm-reserves its IM under RfqWitness.
public fun submit_quote<C>(
    rfq: &Rfq<C>,
    maker_inst: &mut Institution<C>,
    maker_cap: &TraderCap,
    allow: &OtcAllowlist,
    entry_price: u64,
    quote_ttl_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(rfq.status == RFQ_OPEN, errors::e_rfq_not_open());
    let now = clock::timestamp_ms(clock);
    assert!(now < rfq.rfq_expiry_ms, errors::e_rfq_expired());
    let maker_id = object::id(maker_inst);
    assert!(maker_id != rfq.requester_inst, errors::e_not_counterparties());
    if (!vec_set::is_empty(&rfq.targets)) {
        assert!(vec_set::contains(&rfq.targets, &maker_id), errors::e_not_targeted());
    };
    assert!(entry_price > 0, errors::e_zero_price());
    if (rfq.min_price > 0) assert!(entry_price >= rfq.min_price, errors::e_price_out_of_band());
    if (rfq.max_price > 0) assert!(entry_price <= rfq.max_price, errors::e_price_out_of_band());
    assert!(quote_ttl_ms > 0, errors::e_bad_params());
    let quote_expiry_ms = now + quote_ttl_ms;
    assert!(quote_expiry_ms <= rfq.rfq_expiry_ms, errors::e_quote_outlives_rfq());

    let maker_trader = institution::trader_of_cap(maker_cap);
    let maintenance = otc_forward::maintenance_of(rfq.im_each);
    let quote = Quote<C> {
        id: object::new(ctx),
        rfq_id: object::id(rfq),
        maker_inst: maker_id,
        maker_trader,
        maker_cap_id: object::id(maker_cap),
        entry_price,
        im_each: rfq.im_each,
        maintenance_each: maintenance,
        quote_expiry_ms,
        status: QUOTE_LIVE,
        reserved_im: rfq.im_each,
    };
    let quote_id = object::id(&quote);

    // firm commitment: re-runs the maker's full assert_trader + book_size/available
    institution::reserve_margin<C, RfqWitness>(
        maker_inst,
        otc_forward::rfq_witness(),
        allow,
        maker_cap,
        quote_id,
        rfq.requester_inst,
        rfq.im_each,
        maintenance,
    );
    events::emit_quote_submitted(
        object::id(rfq),
        quote_id,
        maker_id,
        maker_trader,
        entry_price,
        rfq.im_each,
        quote_expiry_ms,
        ctx.sender(),
    );
    transfer::share_object(quote);
    quote_id
}

/// THE single transaction that solves async-open. Signed by the REQUESTER only.
public fun accept_quote<C>(
    rfq: &mut Rfq<C>,
    quote: &mut Quote<C>,
    requester_inst: &mut Institution<C>,
    requester_cap: &TraderCap,
    maker_inst: &mut Institution<C>, // shared ref; NO maker signature
    allow: &OtcAllowlist,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(quote.rfq_id == object::id(rfq), errors::e_quote_rfq_mismatch());
    assert!(rfq.status == RFQ_OPEN, errors::e_rfq_not_open());
    let now = clock::timestamp_ms(clock);
    assert!(now < rfq.rfq_expiry_ms, errors::e_rfq_expired());
    assert!(quote.status == QUOTE_LIVE, errors::e_quote_not_live());
    assert!(now < quote.quote_expiry_ms, errors::e_quote_expired());
    assert!(object::id(requester_inst) == rfq.requester_inst, errors::e_not_requester());
    assert!(institution::trader_of_cap(requester_cap) == rfq.requester_trader, errors::e_not_requester());
    institution::assert_trader_external(requester_inst, requester_cap);
    assert!(object::id(maker_inst) == quote.maker_inst, errors::e_wrong_maker_inst());
    assert!(object::id(requester_inst) != object::id(maker_inst), errors::e_not_counterparties());

    let requester_is_long = rfq.requester_side == SIDE_REQUESTER_LONG;
    let otc_id = otc_forward::open_from_rfq<C>(
        requester_inst,
        requester_cap,
        requester_is_long,
        maker_inst,
        quote.maker_trader,
        object::id(quote),
        allow,
        rfq.underlying,
        rfq.notional,
        quote.entry_price,
        rfq.im_each,
        rfq.funding_rate_bps,
        rfq.funding_long_pays,
        rfq.settlement_interval_ms,
        rfq.contract_expiry_ms,
        clock,
        ctx,
    );
    quote.status = QUOTE_ACCEPTED;
    rfq.status = RFQ_FILLED;
    rfq.accepted_quote = option::some(object::id(quote));
    events::emit_rfq_filled(
        object::id(rfq),
        object::id(quote),
        otc_id,
        rfq.requester_inst,
        quote.maker_inst,
        quote.entry_price,
        rfq.im_each,
        ctx.sender(),
    );
    otc_id
}

/// Maker pulls a live quote (the trust-minimized "pull"; no last-look). Frees
/// the firm IM. Status check fires before release so a re-keyed/accepted row is
/// never the abort source.
public fun withdraw_quote<C>(
    rfq: &Rfq<C>,
    quote: &mut Quote<C>,
    maker_inst: &mut Institution<C>,
    maker_cap: &TraderCap,
    allow: &OtcAllowlist,
    ctx: &mut TxContext,
) {
    assert!(quote.rfq_id == object::id(rfq), errors::e_quote_rfq_mismatch());
    assert!(quote.status == QUOTE_LIVE, errors::e_quote_not_live());
    assert!(quote.maker_inst == object::id(maker_inst), errors::e_wrong_maker_inst());
    institution::assert_trader_external(maker_inst, maker_cap);
    assert!(institution::trader_of_cap(maker_cap) == quote.maker_trader, errors::e_not_quote_owner());
    let freed = quote.reserved_im;
    institution::release_margin<C, RfqWitness>(maker_inst, otc_forward::rfq_witness(), allow, object::id(quote));
    quote.status = QUOTE_WITHDRAWN;
    events::emit_quote_withdrawn(quote.rfq_id, object::id(quote), quote.maker_inst, freed, ctx.sender());
}

/// Permissionless cleanup of a stale firm escrow once provably expired — bounds
/// the maker's capital lockup to `quote_expiry_ms`.
public fun reclaim_expired_quote<C>(
    quote: &mut Quote<C>,
    maker_inst: &mut Institution<C>,
    allow: &OtcAllowlist,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(quote.status == QUOTE_LIVE, errors::e_quote_not_live());
    assert!(quote.maker_inst == object::id(maker_inst), errors::e_wrong_maker_inst());
    assert!(clock::timestamp_ms(clock) >= quote.quote_expiry_ms, errors::e_quote_not_expired());
    let freed = quote.reserved_im;
    institution::release_margin<C, RfqWitness>(maker_inst, otc_forward::rfq_witness(), allow, object::id(quote));
    quote.status = QUOTE_RECLAIMED;
    events::emit_quote_reclaimed(quote.rfq_id, object::id(quote), quote.maker_inst, freed, ctx.sender());
}

/// Requester tears down an unfilled request. Does NOT free maker quotes (their
/// reservations live in each maker's Institution); makers withdraw/reclaim.
public fun cancel_rfq<C>(
    rfq: &mut Rfq<C>,
    requester_inst: &Institution<C>,
    requester_cap: &TraderCap,
    ctx: &mut TxContext,
) {
    assert!(object::id(requester_inst) == rfq.requester_inst, errors::e_not_requester());
    assert!(institution::trader_of_cap(requester_cap) == rfq.requester_trader, errors::e_not_requester());
    institution::assert_trader_external(requester_inst, requester_cap);
    assert!(rfq.status == RFQ_OPEN, errors::e_rfq_not_open());
    rfq.status = RFQ_CANCELLED;
    events::emit_rfq_cancelled(object::id(rfq), rfq.requester_inst, ctx.sender());
}

// ---- views ----

public fun rfq_status<C>(r: &Rfq<C>): u8 { r.status }

public fun rfq_accepted_quote<C>(r: &Rfq<C>): Option<ID> { r.accepted_quote }

public fun quote_status<C>(q: &Quote<C>): u8 { q.status }

public fun quote_price<C>(q: &Quote<C>): u64 { q.entry_price }

/// (rfq_id, maker_inst, maker_trader, entry_price, im_each, quote_expiry_ms, status)
public fun quote_terms<C>(q: &Quote<C>): (ID, ID, address, u64, u64, u64, u8) {
    (q.rfq_id, q.maker_inst, q.maker_trader, q.entry_price, q.im_each, q.quote_expiry_ms, q.status)
}
