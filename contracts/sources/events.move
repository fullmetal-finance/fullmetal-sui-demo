/// Canonical, BCS-stable event schema for the Fullmetal indexer/frontend.
///
/// All structs are `copy, drop`. Field order is load-bearing for BCS decoding —
/// freeze it. Every mutation event carries `institution_id` (or from/to for
/// settlement) for cheap per-tenant filtering, and an actor (`by`/`trader`) for
/// the audit trail. Each module emits via the `emit_*` helpers so the schema
/// stays identical across the package; later modules only append.
module fullmetal::events;

use std::ascii;
use std::string::String;
use sui::event;

public struct InstitutionCreated has copy, drop {
    institution_id: ID,
    handle: String,
    founding_admin: address,
    admin_cap_id: ID,
    creator: address,
}
public struct AdminAdded has copy, drop { institution_id: ID, new_admin_cap_id: ID, by: address }
public struct AdminRevoked has copy, drop { institution_id: ID, admin_cap_id: ID, by: address }
public struct AdminTransferProposed has copy, drop { institution_id: ID, proposed: address, by: address }
public struct AdminTransferAccepted has copy, drop {
    institution_id: ID,
    new_admin: address,
    new_admin_cap_id: ID,
}
public struct Paused has copy, drop { institution_id: ID, by: address }
public struct Unpaused has copy, drop { institution_id: ID, by: address }
public struct TreasuryDeposited has copy, drop {
    institution_id: ID,
    amount: u64,
    new_total: u64,
    by: address,
}
public struct TreasuryWithdrawn has copy, drop {
    institution_id: ID,
    amount: u64,
    new_total: u64,
    new_available: u64,
    by: address,
}
public struct TraderGranted has copy, drop {
    institution_id: ID,
    trader: address,
    cap_id: ID,
    book_size: u64,
    by: address,
}
public struct TraderRevoked has copy, drop {
    institution_id: ID,
    trader: address,
    cap_id: ID,
    freed: u64,
    by: address,
}
public struct BookSizeChanged has copy, drop {
    institution_id: ID,
    trader: address,
    old_size: u64,
    new_size: u64,
    by: address,
}
public struct WithdrawPermSet has copy, drop {
    institution_id: ID,
    trader: address,
    allowed: bool,
    by: address,
}
public struct CapEpochBumped has copy, drop { institution_id: ID, new_epoch: u64, by: address }
public struct SuinsNameSet has copy, drop {
    institution_id: ID,
    name: Option<String>,
    by: address,
}
public struct MarginReserved has copy, drop {
    institution_id: ID,
    otc_id: ID,
    trader: address,
    counterparty: ID,
    amount: u64,
}
public struct MarginReleased has copy, drop {
    institution_id: ID,
    otc_id: ID,
    trader: address,
    amount: u64,
}
public struct SettlementMade has copy, drop {
    from_inst: ID,
    to_inst: ID,
    otc_id: ID,
    amount: u64,
    by: address,
}
public struct OtcWitnessAllowed has copy, drop { witness: ascii::String, by: address }
public struct OtcWitnessRemoved has copy, drop { witness: ascii::String, by: address }
public struct RehypoCapSet has copy, drop { institution_id: ID, cap_id: ID, by: address }
public struct RehypoSupplied has copy, drop {
    institution_id: ID,
    amount: u64,
    new_rehypothecated: u64,
    by: address,
}
public struct RehypoRecalled has copy, drop {
    institution_id: ID,
    amount: u64,
    new_rehypothecated: u64,
    by: address,
}

public(package) fun emit_institution_created(
    institution_id: ID,
    handle: String,
    founding_admin: address,
    admin_cap_id: ID,
    creator: address,
) {
    event::emit(InstitutionCreated { institution_id, handle, founding_admin, admin_cap_id, creator });
}
public(package) fun emit_admin_added(institution_id: ID, new_admin_cap_id: ID, by: address) {
    event::emit(AdminAdded { institution_id, new_admin_cap_id, by });
}
public(package) fun emit_admin_revoked(institution_id: ID, admin_cap_id: ID, by: address) {
    event::emit(AdminRevoked { institution_id, admin_cap_id, by });
}
public(package) fun emit_admin_transfer_proposed(institution_id: ID, proposed: address, by: address) {
    event::emit(AdminTransferProposed { institution_id, proposed, by });
}
public(package) fun emit_admin_transfer_accepted(
    institution_id: ID,
    new_admin: address,
    new_admin_cap_id: ID,
) {
    event::emit(AdminTransferAccepted { institution_id, new_admin, new_admin_cap_id });
}
public(package) fun emit_paused(institution_id: ID, by: address) {
    event::emit(Paused { institution_id, by });
}
public(package) fun emit_unpaused(institution_id: ID, by: address) {
    event::emit(Unpaused { institution_id, by });
}
public(package) fun emit_treasury_deposited(
    institution_id: ID,
    amount: u64,
    new_total: u64,
    by: address,
) {
    event::emit(TreasuryDeposited { institution_id, amount, new_total, by });
}
public(package) fun emit_treasury_withdrawn(
    institution_id: ID,
    amount: u64,
    new_total: u64,
    new_available: u64,
    by: address,
) {
    event::emit(TreasuryWithdrawn { institution_id, amount, new_total, new_available, by });
}
public(package) fun emit_trader_granted(
    institution_id: ID,
    trader: address,
    cap_id: ID,
    book_size: u64,
    by: address,
) {
    event::emit(TraderGranted { institution_id, trader, cap_id, book_size, by });
}
public(package) fun emit_trader_revoked(
    institution_id: ID,
    trader: address,
    cap_id: ID,
    freed: u64,
    by: address,
) {
    event::emit(TraderRevoked { institution_id, trader, cap_id, freed, by });
}
public(package) fun emit_book_size_changed(
    institution_id: ID,
    trader: address,
    old_size: u64,
    new_size: u64,
    by: address,
) {
    event::emit(BookSizeChanged { institution_id, trader, old_size, new_size, by });
}
public(package) fun emit_withdraw_perm_set(
    institution_id: ID,
    trader: address,
    allowed: bool,
    by: address,
) {
    event::emit(WithdrawPermSet { institution_id, trader, allowed, by });
}
public(package) fun emit_cap_epoch_bumped(institution_id: ID, new_epoch: u64, by: address) {
    event::emit(CapEpochBumped { institution_id, new_epoch, by });
}
public(package) fun emit_suins_name_set(institution_id: ID, name: Option<String>, by: address) {
    event::emit(SuinsNameSet { institution_id, name, by });
}
public(package) fun emit_margin_reserved(
    institution_id: ID,
    otc_id: ID,
    trader: address,
    counterparty: ID,
    amount: u64,
) {
    event::emit(MarginReserved { institution_id, otc_id, trader, counterparty, amount });
}
public(package) fun emit_margin_released(
    institution_id: ID,
    otc_id: ID,
    trader: address,
    amount: u64,
) {
    event::emit(MarginReleased { institution_id, otc_id, trader, amount });
}
public(package) fun emit_settlement_made(
    from_inst: ID,
    to_inst: ID,
    otc_id: ID,
    amount: u64,
    by: address,
) {
    event::emit(SettlementMade { from_inst, to_inst, otc_id, amount, by });
}
public(package) fun emit_otc_witness_allowed(witness: ascii::String, by: address) {
    event::emit(OtcWitnessAllowed { witness, by });
}
public(package) fun emit_otc_witness_removed(witness: ascii::String, by: address) {
    event::emit(OtcWitnessRemoved { witness, by });
}
public(package) fun emit_rehypo_cap_set(institution_id: ID, cap_id: ID, by: address) {
    event::emit(RehypoCapSet { institution_id, cap_id, by });
}
public(package) fun emit_rehypo_supplied(
    institution_id: ID,
    amount: u64,
    new_rehypothecated: u64,
    by: address,
) {
    event::emit(RehypoSupplied { institution_id, amount, new_rehypothecated, by });
}
public(package) fun emit_rehypo_recalled(
    institution_id: ID,
    amount: u64,
    new_rehypothecated: u64,
    by: address,
) {
    event::emit(RehypoRecalled { institution_id, amount, new_rehypothecated, by });
}

// ----- RFQ -----

public struct MarginRekeyed has copy, drop {
    institution_id: ID,
    old_otc_id: ID,
    new_otc_id: ID,
    trader: address,
    amount: u64,
}
public struct RfqOpened has copy, drop {
    rfq_id: ID,
    requester_inst: ID,
    requester_trader: address,
    requester_side: u8,
    underlying: String,
    notional: u64,
    im_each: u64,
    targets_len: u64,
    rfq_expiry_ms: u64,
    by: address,
}
public struct QuoteSubmitted has copy, drop {
    rfq_id: ID,
    quote_id: ID,
    maker_inst: ID,
    maker_trader: address,
    entry_price: u64,
    im_each: u64,
    quote_expiry_ms: u64,
    by: address,
}
public struct QuoteWithdrawn has copy, drop { rfq_id: ID, quote_id: ID, maker_inst: ID, freed: u64, by: address }
public struct QuoteReclaimed has copy, drop { rfq_id: ID, quote_id: ID, maker_inst: ID, freed: u64, by: address }
public struct RfqFilled has copy, drop {
    rfq_id: ID,
    quote_id: ID,
    otc_id: ID,
    requester_inst: ID,
    maker_inst: ID,
    entry_price: u64,
    im_each: u64,
    by: address,
}
public struct RfqCancelled has copy, drop { rfq_id: ID, requester_inst: ID, by: address }

public(package) fun emit_margin_rekeyed(
    institution_id: ID,
    old_otc_id: ID,
    new_otc_id: ID,
    trader: address,
    amount: u64,
) {
    event::emit(MarginRekeyed { institution_id, old_otc_id, new_otc_id, trader, amount });
}
public(package) fun emit_rfq_opened(
    rfq_id: ID,
    requester_inst: ID,
    requester_trader: address,
    requester_side: u8,
    underlying: String,
    notional: u64,
    im_each: u64,
    targets_len: u64,
    rfq_expiry_ms: u64,
    by: address,
) {
    event::emit(RfqOpened {
        rfq_id,
        requester_inst,
        requester_trader,
        requester_side,
        underlying,
        notional,
        im_each,
        targets_len,
        rfq_expiry_ms,
        by,
    });
}
public(package) fun emit_quote_submitted(
    rfq_id: ID,
    quote_id: ID,
    maker_inst: ID,
    maker_trader: address,
    entry_price: u64,
    im_each: u64,
    quote_expiry_ms: u64,
    by: address,
) {
    event::emit(QuoteSubmitted {
        rfq_id,
        quote_id,
        maker_inst,
        maker_trader,
        entry_price,
        im_each,
        quote_expiry_ms,
        by,
    });
}
public(package) fun emit_quote_withdrawn(rfq_id: ID, quote_id: ID, maker_inst: ID, freed: u64, by: address) {
    event::emit(QuoteWithdrawn { rfq_id, quote_id, maker_inst, freed, by });
}
public(package) fun emit_quote_reclaimed(rfq_id: ID, quote_id: ID, maker_inst: ID, freed: u64, by: address) {
    event::emit(QuoteReclaimed { rfq_id, quote_id, maker_inst, freed, by });
}
public(package) fun emit_rfq_filled(
    rfq_id: ID,
    quote_id: ID,
    otc_id: ID,
    requester_inst: ID,
    maker_inst: ID,
    entry_price: u64,
    im_each: u64,
    by: address,
) {
    event::emit(RfqFilled { rfq_id, quote_id, otc_id, requester_inst, maker_inst, entry_price, im_each, by });
}
public(package) fun emit_rfq_cancelled(rfq_id: ID, requester_inst: ID, by: address) {
    event::emit(RfqCancelled { rfq_id, requester_inst, by });
}

// ----- direct offer (bilateral, no competitive quoting) -----

public struct DirectOffered has copy, drop {
    offer_id: ID,
    proposer_inst: ID,
    counterparty_inst: ID,
    proposer_trader: address,
    proposer_side: u8,
    underlying: String,
    notional: u64,
    entry_price: u64,
    im_each: u64,
    offer_expiry_ms: u64,
    by: address,
}
public struct DirectAccepted has copy, drop {
    offer_id: ID,
    otc_id: ID,
    proposer_inst: ID,
    counterparty_inst: ID,
    entry_price: u64,
    im_each: u64,
    by: address,
}
public struct DirectWithdrawn has copy, drop { offer_id: ID, proposer_inst: ID, freed: u64, by: address }
public struct DirectReclaimed has copy, drop { offer_id: ID, proposer_inst: ID, freed: u64, by: address }

public(package) fun emit_direct_offered(
    offer_id: ID,
    proposer_inst: ID,
    counterparty_inst: ID,
    proposer_trader: address,
    proposer_side: u8,
    underlying: String,
    notional: u64,
    entry_price: u64,
    im_each: u64,
    offer_expiry_ms: u64,
    by: address,
) {
    event::emit(DirectOffered {
        offer_id,
        proposer_inst,
        counterparty_inst,
        proposer_trader,
        proposer_side,
        underlying,
        notional,
        entry_price,
        im_each,
        offer_expiry_ms,
        by,
    });
}
public(package) fun emit_direct_accepted(
    offer_id: ID,
    otc_id: ID,
    proposer_inst: ID,
    counterparty_inst: ID,
    entry_price: u64,
    im_each: u64,
    by: address,
) {
    event::emit(DirectAccepted { offer_id, otc_id, proposer_inst, counterparty_inst, entry_price, im_each, by });
}
public(package) fun emit_direct_withdrawn(offer_id: ID, proposer_inst: ID, freed: u64, by: address) {
    event::emit(DirectWithdrawn { offer_id, proposer_inst, freed, by });
}
public(package) fun emit_direct_reclaimed(offer_id: ID, proposer_inst: ID, freed: u64, by: address) {
    event::emit(DirectReclaimed { offer_id, proposer_inst, freed, by });
}
