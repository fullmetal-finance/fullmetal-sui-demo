#[test_only]
module fullmetal::rfq_tests;

use std::string;
use std::type_name;
use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use fullmetal::institution::{Self, Institution, AdminCap, TraderCap};
use fullmetal::otc_forward::{OtcWitness, RfqWitness};
use fullmetal::protocol::{Self, OtcAllowlist, ProtocolCap};
use fullmetal::registry::{Self, HandleRegistry};
use fullmetal::rfq::{Self, Rfq, Quote};

public struct FAKE has drop {}

const OP: address = @0x0B;
const SUI: vector<u8> = b"SUI";
const IM: u64 = 200_000_000; // 200 DBUSDC IM each side

public struct World has drop { req_inst: ID, mkr_inst: ID, req_admin: ID, mkr_admin: ID, req_trader: ID, mkr_trader: ID }

#[allow(deprecated_usage)]
fun setup(sc: &mut ts::Scenario): World {
    protocol::init_for_testing(sc.ctx());
    registry::init_for_testing(sc.ctx());

    // allowlist BOTH the OTC and RFQ witnesses
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

#[test]
fun rfq_request_quote_accept_opens_contract() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);

    // requester opens an RFQ (long SUI, 100 units, broadcast)
    sc.next_tx(OP);
    let rfq_id = {
        let inst = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.req_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.req_trader);
        let clk = clock::create_for_testing(sc.ctx());
        let id = rfq::open_rfq<FAKE>(
            &inst, &cap, vector[], 0 /*requester long*/, string::utf8(SUI),
            100_000_000, IM, 0, false, 0, 0,
            1_900_000, 2_100_000, // price band
            3_600_000, // rfq ttl
            &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
        id
    };

    // maker submits a firm quote @ $2.00 -> reserves maker IM
    sc.next_tx(OP);
    let quote_id = {
        let rfq = ts::take_shared_by_id<Rfq<FAKE>>(&sc, rfq_id);
        let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.mkr_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        let id = rfq::submit_quote<FAKE>(&rfq, &mut mkr, &cap, &allow, 2_000_000, 1_000_000, &clk, sc.ctx());
        // maker IM now firm-reserved
        assert!(institution::reserved_of(&mkr) == IM, 1);
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(mkr);
        ts::return_shared(rfq);
        id
    };

    // requester accepts -> opens the OtcForward atomically
    sc.next_tx(OP);
    {
        let mut rfq = ts::take_shared_by_id<Rfq<FAKE>>(&sc, rfq_id);
        let mut quote = ts::take_shared_by_id<Quote<FAKE>>(&sc, quote_id);
        let mut req = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.req_inst);
        let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.req_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        rfq::accept_quote<FAKE>(&mut rfq, &mut quote, &mut req, &cap, &mut mkr, &allow, &clk, sc.ctx());

        // both legs reserved at IM; RFQ filled; quote accepted
        assert!(institution::reserved_of(&req) == IM, 2);
        assert!(institution::reserved_of(&mkr) == IM, 3);
        assert!(rfq::rfq_status(&rfq) == 1 /*FILLED*/, 4);
        assert!(rfq::quote_status(&quote) == 2 /*ACCEPTED*/, 5);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(req);
        ts::return_shared(mkr);
        ts::return_shared(quote);
        ts::return_shared(rfq);
    };
    ts::end(sc);
}

#[test]
fun withdraw_quote_frees_maker_im() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);

    sc.next_tx(OP);
    let rfq_id = {
        let inst = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.req_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.req_trader);
        let clk = clock::create_for_testing(sc.ctx());
        let id = rfq::open_rfq<FAKE>(
            &inst, &cap, vector[], 0, string::utf8(SUI), 100_000_000, IM, 0, false, 0, 0, 0, 0, 3_600_000, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
        id
    };

    sc.next_tx(OP);
    let quote_id = {
        let rfq = ts::take_shared_by_id<Rfq<FAKE>>(&sc, rfq_id);
        let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.mkr_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        let id = rfq::submit_quote<FAKE>(&rfq, &mut mkr, &cap, &allow, 2_000_000, 1_000_000, &clk, sc.ctx());
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(mkr);
        ts::return_shared(rfq);
        id
    };

    // maker withdraws -> IM freed back to 0
    sc.next_tx(OP);
    {
        let rfq = ts::take_shared_by_id<Rfq<FAKE>>(&sc, rfq_id);
        let mut quote = ts::take_shared_by_id<Quote<FAKE>>(&sc, quote_id);
        let mut mkr = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.mkr_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.mkr_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        rfq::withdraw_quote<FAKE>(&rfq, &mut quote, &mut mkr, &cap, &allow, sc.ctx());
        assert!(institution::reserved_of(&mkr) == 0, 1);
        assert!(rfq::quote_status(&quote) == 1 /*WITHDRAWN*/, 2);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(mkr);
        ts::return_shared(quote);
        ts::return_shared(rfq);
    };
    ts::end(sc);
}
