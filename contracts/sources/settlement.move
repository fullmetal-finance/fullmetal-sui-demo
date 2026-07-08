/// Atomic inter-institution value transfer via a hot potato. `begin_settlement`
/// debits the payer's FREE funds (gated on `available`, so reserved IM is never
/// spent by a counterparty payment) and returns a `SettlementTicket` that
/// CARRIES the `Balance<C>` and has NO abilities — it cannot be stored, copied,
/// or dropped, so it MUST be consumed by `finish_settlement` in the same PTB.
/// A payer shortfall aborts the whole PTB: that abort IS the "VM/funding
/// settlement failed for lack of funds" signal the OTC layer catches.
module fullmetal::settlement;

use std::type_name;
use sui::balance::{Self, Balance};
use fullmetal::errors;
use fullmetal::events;
use fullmetal::institution::{Self, Institution};
use fullmetal::protocol::{Self, OtcAllowlist};

/// Hot potato: no abilities => must be consumed this tx. Carries the debited funds.
public struct SettlementTicket<phantom C> {
    from_inst: ID,
    to_inst: ID,
    otc_id: ID,
    funds: Balance<C>,
}

// `get_with_original_ids` is the upgrade-stable accessor on Sui 1.72.x.
//
/// Debit `amount` of the payer's free funds. Witness-gated (same allowlist as
/// margin); no AdminCap. To pay VM out of reserved IM, the OTC layer composes
/// `institution::release_margin` then `begin_settlement` in one PTB.
///
/// NOT pause-gated, deliberately: settlement here only honors an EXISTING,
/// witness-authorized contract obligation (VM/funding/close-out to a bound
/// counterparty). Pause is the payer-admin's own switch; letting it block
/// settlement would let a losing desk self-pause to repudiate its mark-to-market
/// losses and wait for mean-reversion (a confirmed look-back griefing attack).
/// Pause still stops the payer's DISCRETIONARY outflows — `withdraw_treasury`
/// and new-contract `reserve_margin` both check `assert_not_paused`.
///
/// The caller must ensure `amount` is physically coverable — `available` counts
/// rehypothecated funds (equity = liquid + deployed) but `balance::split` moves
/// only the physical liquid balance, so a caller that has not recalled deployed
/// funds must gate on `institution::total` (physical) too. The OTC layer does
/// (see `otc_forward::settle_at_mark`), routing a physical shortfall through the
/// margin-call / recall path instead of aborting here.
#[allow(deprecated_usage)]
public fun begin_settlement<C, W: drop>(
    payer: &mut Institution<C>,
    _w: W,
    allow: &OtcAllowlist,
    to_inst: ID,
    otc_id: ID,
    amount: u64,
): SettlementTicket<C> {
    let wname = type_name::get_with_original_ids<W>().into_string();
    assert!(protocol::is_witness_allowed(allow, &wname), errors::e_witness_not_allowed());
    assert!(amount <= institution::available(payer), errors::e_insufficient_treasury());
    let from_inst = object::id(payer);
    let funds = balance::split(institution::treasury_mut(payer), amount);
    SettlementTicket { from_inst, to_inst, otc_id, funds }
}

/// Credit the carried funds into the payee. Possessing the un-droppable ticket
/// is the authorization — no witness needed.
public fun finish_settlement<C>(
    payee: &mut Institution<C>,
    ticket: SettlementTicket<C>,
    ctx: &mut TxContext,
) {
    let SettlementTicket { from_inst, to_inst, otc_id, funds } = ticket;
    assert!(object::id(payee) == to_inst, errors::e_ticket_mismatch());
    let amount = balance::value(&funds);
    balance::join(institution::treasury_mut(payee), funds);
    events::emit_settlement_made(from_inst, to_inst, otc_id, amount, ctx.sender());
}
