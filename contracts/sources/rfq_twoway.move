/// Two-way RFQ — the information-disciplined replacement for `rfq` (Phase A of
/// WHITEPAPER.md §5.1). Same firm-quote machinery (maker IM reserved at quote
/// time under `RfqWitness`, no last look, requester-only accept), but designed
/// so the request stops paying for its own front-running:
///
///  1. NO DIRECTION. The request carries no side. Every quote is a two-way
///     market — the maker posts `bid` AND `ask` — and the requester picks a
///     side only inside `accept`, Tradeweb-RFM style. One IM reservation
///     covers the quote because only one side can ever execute.
///  2. SIZE BUCKETS. The request carries only a bucket CEILING; quotes and IM
///     price the ceiling; the exact notional (≤ ceiling) appears only at
///     accept. Slight over-margining pre-accept, in the safe direction.
///  3. SINGLE-SHOT QUOTES. One quote per maker institution per RFQ, tracked in
///     `quoted`. Withdrawing frees the maker's IM but does NOT return their
///     shot — the quote→watch rivals→withdraw→undercut loop is closed.
///  4. NO LIMIT BAND ON-CHAIN. The requester's reservation price never leaves
///     the client (the old `min_price`/`max_price` told makers exactly where
///     quotes would be accepted).
///  5. EVENT DIET. Events carry object ids and expiries — no identities, no
///     prices, no side (there is none), no bucket. Counterparty identity stays
///     readable on the shared objects themselves (makers need it for credit),
///     but the indexed firehose stops broadcasting the trading intent.
///     Post-trade, `ContractOpened` still discloses terms — sealing that is
///     Phase C (Seal/Walrus), out of scope here.
///
/// Additive module: the deployed `rfq` stays untouched (frozen signatures);
/// both reuse `RfqWitness` + `open_from_rfq`, so no new allowlist entry.
module fullmetal::rfq_twoway;

use std::string::String;
use sui::clock::{Self, Clock};
use sui::event;
use sui::vec_set::{Self, VecSet};
use fullmetal::errors;
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

/// The request. Note what is ABSENT vs `rfq::Rfq`: no side, no exact notional
/// (bucket ceiling only), no price band.
public struct TwoWayRfq<phantom C> has key {
    id: UID,
    requester_inst: ID,
    requester_trader: address,
    targets: VecSet<ID>, // invited maker institutions; empty = broadcast
    quoted: VecSet<ID>, // makers who used their single shot (incl. withdrawn)
    underlying: String,
    bucket_max: u64, // notional CEILING (1e6); exact size fixed at accept
    im_each: u64, // per-side IM, sized for the ceiling
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    contract_expiry_ms: u64,
    rfq_expiry_ms: u64,
    status: u8,
    accepted_quote: Option<ID>,
}

/// A firm two-way market: the maker BUYS at `bid` / SELLS at `ask`. Accepting
/// the ask puts the requester long at `ask`; hitting the bid puts the
/// requester short at `bid`. One reservation backs both (one side executes).
public struct TwoWayQuote<phantom C> has key {
    id: UID,
    rfq_id: ID,
    maker_inst: ID,
    maker_trader: address,
    maker_cap_id: ID,
    bid: u64, // 1e6; maker buys (requester would go SHORT here)
    ask: u64, // 1e6; maker sells (requester would go LONG here)
    im_each: u64,
    maintenance_each: u64,
    quote_expiry_ms: u64,
    status: u8,
    reserved_im: u64,
}

// ---- events: id + expiry only. No identities, prices, sides, or sizes. ----
public struct TwoWayRfqOpened has copy, drop {
    rfq_id: ID,
    underlying: String,
    rfq_expiry_ms: u64,
    targeted: bool, // whether a maker panel was named (not who)
}
public struct TwoWayQuoteSubmitted has copy, drop { rfq_id: ID, quote_id: ID, quote_expiry_ms: u64 }
public struct TwoWayRfqFilled has copy, drop { rfq_id: ID, quote_id: ID, otc_id: ID }
public struct TwoWayQuoteWithdrawn has copy, drop { rfq_id: ID, quote_id: ID }
public struct TwoWayQuoteReclaimed has copy, drop { rfq_id: ID, quote_id: ID }
public struct TwoWayRfqCancelled has copy, drop { rfq_id: ID }

/// Requester posts a two-way request. No margin locked, no side revealed.
/// `bucket_max` should be a standardized bucket ceiling (UI concern), never
/// the exact intended size.
public fun open_two_way<C>(
    requester_inst: &Institution<C>,
    requester_cap: &TraderCap,
    targets: vector<ID>,
    underlying: String,
    bucket_max: u64,
    im_each: u64,
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    contract_expiry_ms: u64,
    rfq_ttl_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    institution::assert_not_paused(requester_inst);
    institution::assert_trader_external(requester_inst, requester_cap);
    assert!(bucket_max > 0, errors::e_zero_notional());
    assert!(im_each > 0, errors::e_zero_amount());
    assert!(rfq_ttl_ms > 0, errors::e_bad_params());

    let mut tset = vec_set::empty<ID>();
    let mut i = 0;
    while (i < vector::length(&targets)) {
        let t = *vector::borrow(&targets, i);
        if (!vec_set::contains(&tset, &t)) vec_set::insert(&mut tset, t);
        i = i + 1;
    };
    let targeted = !vec_set::is_empty(&tset);

    let rfq = TwoWayRfq<C> {
        id: object::new(ctx),
        requester_inst: object::id(requester_inst),
        requester_trader: institution::trader_of_cap(requester_cap),
        targets: tset,
        quoted: vec_set::empty(),
        underlying,
        bucket_max,
        im_each,
        funding_rate_bps,
        funding_long_pays,
        settlement_interval_ms,
        contract_expiry_ms,
        rfq_expiry_ms: clock::timestamp_ms(clock) + rfq_ttl_ms,
        status: RFQ_OPEN,
        accepted_quote: option::none(),
    };
    let rfq_id = object::id(&rfq);
    event::emit(TwoWayRfqOpened {
        rfq_id,
        underlying: rfq.underlying,
        rfq_expiry_ms: rfq.rfq_expiry_ms,
        targeted,
    });
    transfer::share_object(rfq);
    rfq_id
}

/// Maker posts a firm two-way market. SINGLE SHOT: a maker institution may
/// quote each RFQ exactly once — withdrawing does not restore the shot, so
/// reading rivals and re-quoting one tick better is impossible. IM for the
/// bucket ceiling is reserved immediately (the firmness bond).
public fun submit_two_way_quote<C>(
    rfq: &mut TwoWayRfq<C>,
    maker_inst: &mut Institution<C>,
    maker_cap: &TraderCap,
    allow: &OtcAllowlist,
    bid: u64,
    ask: u64,
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
    assert!(!vec_set::contains(&rfq.quoted, &maker_id), errors::e_already_quoted());
    assert!(bid > 0 && ask > 0, errors::e_zero_price());
    assert!(bid <= ask, errors::e_crossed_quote());
    assert!(quote_ttl_ms > 0, errors::e_bad_params());
    let quote_expiry_ms = now + quote_ttl_ms;
    assert!(quote_expiry_ms <= rfq.rfq_expiry_ms, errors::e_quote_outlives_rfq());

    vec_set::insert(&mut rfq.quoted, maker_id);
    let maintenance = otc_forward::maintenance_of(rfq.im_each);
    let quote = TwoWayQuote<C> {
        id: object::new(ctx),
        rfq_id: object::id(rfq),
        maker_inst: maker_id,
        maker_trader: institution::trader_of_cap(maker_cap),
        maker_cap_id: object::id(maker_cap),
        bid,
        ask,
        im_each: rfq.im_each,
        maintenance_each: maintenance,
        quote_expiry_ms,
        status: QUOTE_LIVE,
        reserved_im: rfq.im_each,
    };
    let quote_id = object::id(&quote);

    // firm commitment: full assert_trader + book-size + liquidity re-check
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
    event::emit(TwoWayQuoteSubmitted { rfq_id: object::id(rfq), quote_id, quote_expiry_ms });
    transfer::share_object(quote);
    quote_id
}

/// Requester lifts one side of a quote. `take_ask = true` ⇒ requester goes
/// LONG at `quote.ask`; false ⇒ requester goes SHORT at `quote.bid`. The
/// side and the exact notional (≤ bucket ceiling) exist nowhere on-chain
/// before this call. Maker never co-signs; their reservation is re-keyed.
public fun accept_two_way<C>(
    rfq: &mut TwoWayRfq<C>,
    quote: &mut TwoWayQuote<C>,
    requester_inst: &mut Institution<C>,
    requester_cap: &TraderCap,
    maker_inst: &mut Institution<C>,
    allow: &OtcAllowlist,
    take_ask: bool,
    notional: u64,
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
    assert!(object::id(maker_inst) == quote.maker_inst, errors::e_wrong_maker_inst());
    assert!(notional > 0, errors::e_zero_notional());
    assert!(notional <= rfq.bucket_max, errors::e_over_bucket());

    let entry_price = if (take_ask) quote.ask else quote.bid;
    let otc_id = otc_forward::open_from_rfq(
        requester_inst,
        requester_cap,
        take_ask, // requester long iff lifting the ask
        maker_inst,
        quote.maker_trader,
        object::id(quote),
        allow,
        rfq.underlying,
        notional,
        entry_price,
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
    event::emit(TwoWayRfqFilled { rfq_id: object::id(rfq), quote_id: object::id(quote), otc_id });
    otc_id
}

/// Maker pulls a live quote — frees the IM bond, but the single shot stays
/// spent (`quoted` is never cleared).
public fun withdraw_two_way_quote<C>(
    rfq: &TwoWayRfq<C>,
    quote: &mut TwoWayQuote<C>,
    maker_inst: &mut Institution<C>,
    maker_cap: &TraderCap,
    allow: &OtcAllowlist,
    _ctx: &mut TxContext,
) {
    assert!(quote.rfq_id == object::id(rfq), errors::e_quote_rfq_mismatch());
    assert!(quote.status == QUOTE_LIVE, errors::e_quote_not_live());
    assert!(object::id(maker_inst) == quote.maker_inst, errors::e_wrong_maker_inst());
    assert!(institution::trader_of_cap(maker_cap) == quote.maker_trader, errors::e_not_quote_owner());
    quote.status = QUOTE_WITHDRAWN;
    institution::release_margin<C, RfqWitness>(
        maker_inst,
        otc_forward::rfq_witness(),
        allow,
        object::id(quote),
    );
    event::emit(TwoWayQuoteWithdrawn { rfq_id: quote.rfq_id, quote_id: object::id(quote) });
}

/// Anyone may free an expired quote's reservation (bounds maker lockup).
public fun reclaim_expired_two_way_quote<C>(
    quote: &mut TwoWayQuote<C>,
    maker_inst: &mut Institution<C>,
    allow: &OtcAllowlist,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    assert!(quote.status == QUOTE_LIVE, errors::e_quote_not_live());
    assert!(clock::timestamp_ms(clock) >= quote.quote_expiry_ms, errors::e_quote_not_expired());
    assert!(object::id(maker_inst) == quote.maker_inst, errors::e_wrong_maker_inst());
    quote.status = QUOTE_RECLAIMED;
    institution::release_margin<C, RfqWitness>(
        maker_inst,
        otc_forward::rfq_witness(),
        allow,
        object::id(quote),
    );
    event::emit(TwoWayQuoteReclaimed { rfq_id: quote.rfq_id, quote_id: object::id(quote) });
}

/// Requester closes the request. Makers withdraw/reclaim their own quotes.
public fun cancel_two_way<C>(
    rfq: &mut TwoWayRfq<C>,
    requester_inst: &Institution<C>,
    requester_cap: &TraderCap,
    _ctx: &mut TxContext,
) {
    assert!(object::id(requester_inst) == rfq.requester_inst, errors::e_not_requester());
    assert!(institution::trader_of_cap(requester_cap) == rfq.requester_trader, errors::e_not_requester());
    assert!(rfq.status == RFQ_OPEN, errors::e_rfq_not_open());
    rfq.status = RFQ_CANCELLED;
    event::emit(TwoWayRfqCancelled { rfq_id: object::id(rfq) });
}

// ---- views ----

public fun rfq_status<C>(rfq: &TwoWayRfq<C>): u8 { rfq.status }

public fun rfq_accepted_quote<C>(rfq: &TwoWayRfq<C>): Option<ID> { rfq.accepted_quote }

public fun rfq_bucket_max<C>(rfq: &TwoWayRfq<C>): u64 { rfq.bucket_max }

public fun has_quoted<C>(rfq: &TwoWayRfq<C>, maker_inst: ID): bool {
    vec_set::contains(&rfq.quoted, &maker_inst)
}

public fun quote_status<C>(q: &TwoWayQuote<C>): u8 { q.status }

/// The two-way market: (bid, ask).
public fun quote_market<C>(q: &TwoWayQuote<C>): (u64, u64) { (q.bid, q.ask) }

public fun quote_terms<C>(q: &TwoWayQuote<C>): (ID, ID, address, u64, u64, u64, u8) {
    (q.rfq_id, q.maker_inst, q.maker_trader, q.im_each, q.quote_expiry_ms, q.reserved_im, q.status)
}
