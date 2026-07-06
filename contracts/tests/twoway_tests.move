#[test_only]
/// Tests for the two-way RFQ (WHITEPAPER.md §5.1 Phase A): direction hidden
/// until accept, single-shot firm quotes, bucket-ceiling sizing.
module fullmetal::twoway_tests;

use std::string;
use std::type_name;
use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use fullmetal::institution::{Self, Institution, AdminCap, TraderCap};
use fullmetal::otc_forward::{Self, OtcForward, OtcWitness, RfqWitness};
use fullmetal::protocol::{Self, OtcAllowlist, ProtocolCap};
use fullmetal::registry::{Self, HandleRegistry};
use fullmetal::rfq_twoway::{Self, TwoWayRfq, TwoWayQuote};

public struct FAKE has drop {}

const OP: address = @0x0B;
const SUI: vector<u8> = b"SUI";
const IM: u64 = 200_000_000; // 200 IM each side (sized for the bucket ceiling)
const BUCKET: u64 = 100_000_000; // 100-unit notional ceiling

public struct World has drop {
    req_inst: ID,
    mkr_inst: ID,
    req_admin: ID,
    mkr_admin: ID,
    req_trader: ID,
    mkr_trader: ID,
}

#[allow(deprecated_usage)]
fun setup(sc: &mut ts::Scenario): World {
    protocol::init_for_testing(sc.ctx());
    registry::init_for_testing(sc.ctx());
    sc.next_tx(OP);
    {
        let mut allow = ts::take_shared<OtcAllowlist>(sc);
        let pcap = ts::take_from_sender<ProtocolCap>(sc);
        protocol::allow_otc_witness(&mut allow, &pcap, type_name::get_with_original_ids<OtcWitness>().into_string(), sc.ctx());
        protocol::allow_otc_witness(&mut allow, &pcap, type_name::get_with_original_ids<RfqWitness>().into_string(), sc.ctx());
        ts::return_to_sender(sc, pcap);
        ts::return_shared(allow);
    };
    let (req_inst, req_admin) = make_inst(sc, b"acme");
    let req_trader = grant(sc, req_inst, req_admin);
    let (mkr_inst, mkr_admin) = make_inst(sc, b"bobsec");
    let mkr_trader = grant(sc, mkr_inst, mkr_admin);
    World { req_inst, mkr_inst, req_admin, mkr_admin, req_trader, mkr_trader }
}

fun make_inst(sc: &mut ts::Scenario, handle: vector<u8>): (ID, ID) {
    sc.next_tx(OP);
    let mut reg = ts::take_shared<HandleRegistry>(sc);
    let cap = institution::create_institution<FAKE>(&mut reg, string::utf8(handle), sc.ctx());
    let inst_id = institution::admin_institution_id(&cap);
    let admin_id = object::id(&cap);
    transfer::public_transfer(cap, OP);
    ts::return_shared(reg);
    sc.next_tx(OP);
    {
        let mut inst = ts::take_shared_by_id<Institution<FAKE>>(sc, inst_id);
        let cap = ts::take_from_sender_by_id<AdminCap>(sc, admin_id);
        institution::deposit_treasury(&mut inst, &cap, coin::mint_for_testing<FAKE>(1_000_000_000, sc.ctx()), sc.ctx());
        ts::return_to_sender(sc, cap);
        ts::return_shared(inst);
    };
    (inst_id, admin_id)
}

fun grant(sc: &mut ts::Scenario, inst_id: ID, admin_id: ID): ID {
    sc.next_tx(OP);
    let mut inst = ts::take_shared_by_id<Institution<FAKE>>(sc, inst_id);
    let cap = ts::take_from_sender_by_id<AdminCap>(sc, admin_id);
    let tcap = institution::grant_trader(&mut inst, &cap, OP, 1_000_000_000_000, sc.ctx());
    let tid = object::id(&tcap);
    transfer::public_transfer(tcap, OP);
    ts::return_to_sender(sc, cap);
    ts::return_shared(inst);
    tid
}

/// Open a broadcast two-way RFQ. NOTE what is not among the args: no side.
fun open(sc: &mut ts::Scenario, w: &World): ID {
    sc.next_tx(OP);
    let inst = ts::take_shared_by_id<Institution<FAKE>>(sc, w.req_inst);
    let cap = ts::take_from_sender_by_id<TraderCap>(sc, w.req_trader);
    let clk = clock::create_for_testing(sc.ctx());
    let id = rfq_twoway::open_two_way<FAKE>(
        &inst, &cap, vector[], string::utf8(SUI),
        BUCKET, IM, 0, false, 0, 0,
        3_600_000, &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, cap);
    ts::return_shared(inst);
    id
}

/// Maker posts a two-way market (bid/ask), reserving IM for the ceiling.
fun quote(sc: &mut ts::Scenario, w: &World, rfq_id: ID, bid: u64, ask: u64): ID {
    sc.next_tx(OP);
    let mut rfq = ts::take_shared_by_id<TwoWayRfq<FAKE>>(sc, rfq_id);
    let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(sc, w.mkr_inst);
    let cap = ts::take_from_sender_by_id<TraderCap>(sc, w.mkr_trader);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    let id = rfq_twoway::submit_two_way_quote<FAKE>(
        &mut rfq, &mut mkr, &cap, &allow, bid, ask, 1_000_000, &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, cap);
    ts::return_shared(allow);
    ts::return_shared(mkr);
    ts::return_shared(rfq);
    id
}

fun accept(sc: &mut ts::Scenario, w: &World, rfq_id: ID, quote_id: ID, take_ask: bool, notional: u64): ID {
    sc.next_tx(OP);
    let mut rfq = ts::take_shared_by_id<TwoWayRfq<FAKE>>(sc, rfq_id);
    let mut q = ts::take_shared_by_id<TwoWayQuote<FAKE>>(sc, quote_id);
    let mut req = ts::take_shared_by_id<Institution<FAKE>>(sc, w.req_inst);
    let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(sc, w.mkr_inst);
    let cap = ts::take_from_sender_by_id<TraderCap>(sc, w.req_trader);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    let otc_id = rfq_twoway::accept_two_way<FAKE>(
        &mut rfq, &mut q, &mut req, &cap, &mut mkr, &allow, take_ask, notional, &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, cap);
    ts::return_shared(allow);
    ts::return_shared(mkr);
    ts::return_shared(req);
    ts::return_shared(q);
    ts::return_shared(rfq);
    otc_id
}

// --- tests -----------------------------------------------------------

#[test]
fun lift_ask_opens_requester_long_at_ask() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);
    let rfq_id = open(&mut sc, &w);
    let quote_id = quote(&mut sc, &w, rfq_id, 1_980_000, 2_020_000);

    // maker's IM is firm the moment the two-way market is posted
    sc.next_tx(OP);
    {
        let mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        assert!(institution::reserved_of(&mkr) == IM, 1);
        ts::return_shared(mkr);
    };

    // requester lifts the ASK for 60 of the 100-unit bucket → requester long @2.02
    let otc_id = accept(&mut sc, &w, rfq_id, quote_id, true, 60_000_000);
    sc.next_tx(OP);
    {
        let fwd = ts::take_shared_by_id<OtcForward<FAKE>>(&sc, otc_id);
        let (long_inst, short_inst) = otc_forward::parties(&fwd);
        assert!(long_inst == w.req_inst && short_inst == w.mkr_inst, 2);
        ts::return_shared(fwd);

        let rfq = ts::take_shared_by_id<TwoWayRfq<FAKE>>(&sc, rfq_id);
        assert!(rfq_twoway::rfq_status(&rfq) == 1, 3); // FILLED
        assert!(rfq_twoway::has_quoted(&rfq, w.mkr_inst), 4);
        ts::return_shared(rfq);

        // both sides reserved after fill
        let req = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.req_inst);
        let mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        assert!(institution::reserved_of(&req) == IM, 5);
        assert!(institution::reserved_of(&mkr) == IM, 6);
        ts::return_shared(mkr);
        ts::return_shared(req);
    };
    sc.end();
}

#[test]
fun hit_bid_opens_requester_short_at_bid() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);
    let rfq_id = open(&mut sc, &w);
    let quote_id = quote(&mut sc, &w, rfq_id, 1_980_000, 2_020_000);
    // same request, same quote — the OTHER side. Direction existed nowhere
    // on-chain until this call.
    let otc_id = accept(&mut sc, &w, rfq_id, quote_id, false, BUCKET);
    sc.next_tx(OP);
    {
        let fwd = ts::take_shared_by_id<OtcForward<FAKE>>(&sc, otc_id);
        let (long_inst, short_inst) = otc_forward::parties(&fwd);
        assert!(long_inst == w.mkr_inst && short_inst == w.req_inst, 10);
        ts::return_shared(fwd);
    };
    sc.end();
}

#[test]
#[expected_failure] // EAlreadyQuoted: one shot per maker per RFQ
fun second_quote_from_same_maker_aborts() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);
    let rfq_id = open(&mut sc, &w);
    quote(&mut sc, &w, rfq_id, 1_980_000, 2_020_000);
    quote(&mut sc, &w, rfq_id, 1_990_000, 2_010_000); // tighter re-quote — blocked
    sc.end();
}

#[test]
#[expected_failure] // EAlreadyQuoted: withdrawing does NOT restore the shot
fun withdraw_then_requote_aborts() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);
    let rfq_id = open(&mut sc, &w);
    let quote_id = quote(&mut sc, &w, rfq_id, 1_980_000, 2_020_000);

    sc.next_tx(OP);
    {
        let rfq = ts::take_shared_by_id<TwoWayRfq<FAKE>>(&sc, rfq_id);
        let mut q = ts::take_shared_by_id<TwoWayQuote<FAKE>>(&sc, quote_id);
        let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.mkr_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        rfq_twoway::withdraw_two_way_quote<FAKE>(&rfq, &mut q, &mut mkr, &cap, &allow, sc.ctx());
        assert!(institution::reserved_of(&mkr) == 0, 20); // bond freed…
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(mkr);
        ts::return_shared(q);
        ts::return_shared(rfq);
    };
    quote(&mut sc, &w, rfq_id, 1_990_000, 2_010_000); // …but the shot is spent
    sc.end();
}

#[test]
#[expected_failure] // ECrossedQuote: bid > ask
fun crossed_market_rejected() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);
    let rfq_id = open(&mut sc, &w);
    quote(&mut sc, &w, rfq_id, 2_020_000, 1_980_000);
    sc.end();
}

#[test]
#[expected_failure] // EOverBucket: accept size exceeds the advertised ceiling
fun accept_above_bucket_ceiling_aborts() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);
    let rfq_id = open(&mut sc, &w);
    let quote_id = quote(&mut sc, &w, rfq_id, 1_980_000, 2_020_000);
    accept(&mut sc, &w, rfq_id, quote_id, true, BUCKET + 1);
    sc.end();
}