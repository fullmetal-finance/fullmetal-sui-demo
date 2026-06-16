/// Direct bilateral offer — the "type the counterparty's org ID" path. A trader
/// names ONE counterparty Institution and proposes the WHOLE trade (price
/// included); the named desk simply accepts. This is the mirror of `rfq`:
///
///   RFQ      — requester broadcasts intent, makers COMPETE on price, the
///              responder (maker) commits collateral first, requester accepts.
///   DIRECT   — proposer fixes every term and commits collateral first, the one
///              named counterparty accepts. No competition, no broadcast.
///
/// The async-open crux is solved identically: the proposer firm-reserves its IM
/// at propose time under `RfqWitness` (keyed by the offer's id); `accept_direct`
/// is signed by the COUNTERPARTY only — it reserves its leg live under
/// `OtcWitness` and RE-KEYS the proposer's firm reservation onto the new
/// contract. Reuses `otc_forward::open_from_rfq` unchanged (proposer plays the
/// "maker"/pre-committed role, acceptor plays the "requester"/live role), so
/// there is no new settlement code and no new witness to allowlist.
///
/// Money never sticks: a live offer frees via `withdraw_direct` (proposer pulls)
/// or permissionless `reclaim_expired_direct` once its TTL lapses — the same two
/// escape hatches as an unaccepted quote.
module fullmetal::direct;

use std::string::String;
use sui::clock::{Self, Clock};
use fullmetal::errors;
use fullmetal::events;
use fullmetal::institution::{Self, Institution, TraderCap};
use fullmetal::otc_forward::{Self, RfqWitness};
use fullmetal::protocol::OtcAllowlist;

const OFFER_LIVE: u8 = 0;
const OFFER_ACCEPTED: u8 = 1;
const OFFER_WITHDRAWN: u8 = 2;
const OFFER_RECLAIMED: u8 = 3;

#[allow(unused_const)]
const SIDE_PROPOSER_LONG: u8 = 0; // proposer is long; counterparty is short (documents side 0)
const SIDE_PROPOSER_SHORT: u8 = 1;

/// A firm, collateral-backed bilateral proposal to ONE named counterparty. Its
/// own shared object (discoverable + auditable). The teeth are a ContractRef in
/// the proposer's Institution keyed by `object::id(this)`, reserved under
/// `RfqWitness`; `reserved_im` mirrors it for display.
public struct DirectOffer<phantom C> has key {
    id: UID,
    proposer_inst: ID,
    proposer_trader: address,
    proposer_cap_id: ID,
    counterparty_inst: ID, // the typed org id — only this desk may accept
    proposer_side: u8,
    underlying: String,
    notional: u64,
    entry_price: u64, // FIXED by the proposer (no competitive quoting)
    im_each: u64,
    maintenance_each: u64,
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    contract_expiry_ms: u64,
    offer_expiry_ms: u64,
    status: u8,
    reserved_im: u64,
    accepted_otc: Option<ID>,
}

/// Proposer fixes all terms and firm-reserves its IM under `RfqWitness`, keyed by
/// the offer id. Mirror of `rfq::submit_quote` (the committing side).
public fun propose_direct<C>(
    proposer_inst: &mut Institution<C>,
    proposer_cap: &TraderCap,
    allow: &OtcAllowlist,
    counterparty_inst: ID,
    proposer_side: u8,
    underlying: String,
    notional: u64,
    entry_price: u64,
    im_each: u64,
    funding_rate_bps: u64,
    funding_long_pays: bool,
    settlement_interval_ms: u64,
    contract_expiry_ms: u64,
    offer_ttl_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    institution::assert_not_paused(proposer_inst);
    institution::assert_trader_external(proposer_inst, proposer_cap);
    assert!(proposer_side <= SIDE_PROPOSER_SHORT, errors::e_bad_params());
    assert!(counterparty_inst != object::id(proposer_inst), errors::e_not_counterparties());
    assert!(notional > 0, errors::e_zero_notional());
    assert!(entry_price > 0, errors::e_zero_price());
    assert!(im_each > 0, errors::e_zero_amount());
    assert!(offer_ttl_ms > 0, errors::e_bad_params());

    let maintenance = otc_forward::maintenance_of(im_each);
    let now = clock::timestamp_ms(clock);
    let proposer_trader = institution::trader_of_cap(proposer_cap);

    let offer = DirectOffer<C> {
        id: object::new(ctx),
        proposer_inst: object::id(proposer_inst),
        proposer_trader,
        proposer_cap_id: object::id(proposer_cap),
        counterparty_inst,
        proposer_side,
        underlying,
        notional,
        entry_price,
        im_each,
        maintenance_each: maintenance,
        funding_rate_bps,
        funding_long_pays,
        settlement_interval_ms,
        contract_expiry_ms,
        offer_expiry_ms: now + offer_ttl_ms,
        status: OFFER_LIVE,
        reserved_im: im_each,
        accepted_otc: option::none(),
    };
    let offer_id = object::id(&offer);

    // firm commitment: re-runs the proposer's full assert_trader + book_size/available
    institution::reserve_margin<C, RfqWitness>(
        proposer_inst,
        otc_forward::rfq_witness(),
        allow,
        proposer_cap,
        offer_id,
        counterparty_inst,
        im_each,
        maintenance,
    );
    events::emit_direct_offered(
        offer_id,
        offer.proposer_inst,
        counterparty_inst,
        proposer_trader,
        proposer_side,
        offer.underlying,
        notional,
        entry_price,
        im_each,
        offer.offer_expiry_ms,
        ctx.sender(),
    );
    transfer::share_object(offer);
    offer_id
}

/// The named counterparty accepts, opening the bilateral OtcForward. Signed by
/// the COUNTERPARTY only — it reserves its leg live and re-keys the proposer's
/// firm reservation. The proposer never co-signs (no fade). Mirror of
/// `rfq::accept_quote`, with the live/pre-committed roles swapped.
public fun accept_direct<C>(
    offer: &mut DirectOffer<C>,
    counterparty_inst: &mut Institution<C>,
    counterparty_cap: &TraderCap,
    proposer_inst: &mut Institution<C>, // shared ref; NO proposer signature
    allow: &OtcAllowlist,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    assert!(offer.status == OFFER_LIVE, errors::e_offer_not_live());
    assert!(clock::timestamp_ms(clock) < offer.offer_expiry_ms, errors::e_offer_expired());
    assert!(object::id(counterparty_inst) == offer.counterparty_inst, errors::e_not_counterparty());
    assert!(object::id(proposer_inst) == offer.proposer_inst, errors::e_wrong_proposer_inst());
    assert!(object::id(counterparty_inst) != object::id(proposer_inst), errors::e_not_counterparties());
    institution::assert_trader_external(counterparty_inst, counterparty_cap);

    // proposer chose its own side; the acceptor takes the opposite
    let acceptor_is_long = offer.proposer_side == SIDE_PROPOSER_SHORT;
    let otc_id = otc_forward::open_from_rfq<C>(
        counterparty_inst, // requester role: live cap present in this PTB
        counterparty_cap,
        acceptor_is_long,
        proposer_inst, // maker role: firm reservation gets re-keyed
        offer.proposer_trader,
        object::id(offer),
        allow,
        offer.underlying,
        offer.notional,
        offer.entry_price,
        offer.im_each,
        offer.funding_rate_bps,
        offer.funding_long_pays,
        offer.settlement_interval_ms,
        offer.contract_expiry_ms,
        clock,
        ctx,
    );
    offer.status = OFFER_ACCEPTED;
    offer.accepted_otc = option::some(otc_id);
    events::emit_direct_accepted(
        object::id(offer),
        otc_id,
        offer.proposer_inst,
        offer.counterparty_inst,
        offer.entry_price,
        offer.im_each,
        ctx.sender(),
    );
    otc_id
}

/// Proposer pulls a live offer, freeing its firm IM. Status check fires before
/// release so an accepted offer is never the abort source.
public fun withdraw_direct<C>(
    offer: &mut DirectOffer<C>,
    proposer_inst: &mut Institution<C>,
    proposer_cap: &TraderCap,
    allow: &OtcAllowlist,
    ctx: &mut TxContext,
) {
    assert!(offer.status == OFFER_LIVE, errors::e_offer_not_live());
    assert!(offer.proposer_inst == object::id(proposer_inst), errors::e_wrong_proposer_inst());
    institution::assert_trader_external(proposer_inst, proposer_cap);
    assert!(institution::trader_of_cap(proposer_cap) == offer.proposer_trader, errors::e_not_proposer());
    let freed = offer.reserved_im;
    institution::release_margin<C, RfqWitness>(proposer_inst, otc_forward::rfq_witness(), allow, object::id(offer));
    offer.status = OFFER_WITHDRAWN;
    events::emit_direct_withdrawn(object::id(offer), offer.proposer_inst, freed, ctx.sender());
}

/// Permissionless cleanup of a stale firm offer once provably expired — bounds
/// the proposer's capital lockup to `offer_expiry_ms`.
public fun reclaim_expired_direct<C>(
    offer: &mut DirectOffer<C>,
    proposer_inst: &mut Institution<C>,
    allow: &OtcAllowlist,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(offer.status == OFFER_LIVE, errors::e_offer_not_live());
    assert!(offer.proposer_inst == object::id(proposer_inst), errors::e_wrong_proposer_inst());
    assert!(clock::timestamp_ms(clock) >= offer.offer_expiry_ms, errors::e_offer_not_expired());
    let freed = offer.reserved_im;
    institution::release_margin<C, RfqWitness>(proposer_inst, otc_forward::rfq_witness(), allow, object::id(offer));
    offer.status = OFFER_RECLAIMED;
    events::emit_direct_reclaimed(object::id(offer), offer.proposer_inst, freed, ctx.sender());
}

// ---- views ----

public fun offer_status<C>(o: &DirectOffer<C>): u8 { o.status }

public fun offer_accepted_otc<C>(o: &DirectOffer<C>): Option<ID> { o.accepted_otc }

/// (proposer_inst, counterparty_inst, proposer_trader, proposer_side, entry_price, im_each, offer_expiry_ms, status)
public fun offer_terms<C>(o: &DirectOffer<C>): (ID, ID, address, u8, u64, u64, u64, u8) {
    (
        o.proposer_inst,
        o.counterparty_inst,
        o.proposer_trader,
        o.proposer_side,
        o.entry_price,
        o.im_each,
        o.offer_expiry_ms,
        o.status,
    )
}
