#[test_only]
module fullmetal::direct_tests;

use std::string;
use std::type_name;
use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use fullmetal::direct::{Self, DirectOffer};
use fullmetal::institution::{Self, Institution, AdminCap, TraderCap};
use fullmetal::otc_forward::{OtcWitness, RfqWitness};
use fullmetal::protocol::{Self, OtcAllowlist, ProtocolCap};
use fullmetal::registry::{Self, HandleRegistry};

public struct FAKE has drop {}

const OP: address = @0x0B;
const SUI: vector<u8> = b"SUI";
const IM: u64 = 200_000_000; // 200 DBUSDC IM each side

public struct World has drop { prop_inst: ID, cpty_inst: ID, prop_admin: ID, cpty_admin: ID, prop_trader: ID, cpty_trader: ID }

#[allow(deprecated_usage)]
fun setup(sc: &mut ts::Scenario): World {
    protocol::init_for_testing(sc.ctx());
    registry::init_for_testing(sc.ctx());

    // direct reuses RfqWitness (firm leg) + OtcWitness (live leg) — allowlist both
    sc.next_tx(OP);
    {
        let mut allow = ts::take_shared<OtcAllowlist>(sc);
        let pcap = ts::take_from_sender<ProtocolCap>(sc);
        protocol::allow_otc_witness(&mut allow, &pcap, type_name::get_with_original_ids<OtcWitness>().into_string(), sc.ctx());
        protocol::allow_otc_witness(&mut allow, &pcap, type_name::get_with_original_ids<RfqWitness>().into_string(), sc.ctx());
        ts::return_to_sender(sc, pcap);
        ts::return_shared(allow);
    };

    let (prop_inst, prop_admin) = make_inst(sc, b"acme");
    let prop_trader = grant(sc, prop_inst, prop_admin);
    let (cpty_inst, cpty_admin) = make_inst(sc, b"bobsec");
    let cpty_trader = grant(sc, cpty_inst, cpty_admin);
    World { prop_inst, cpty_inst, prop_admin, cpty_admin, prop_trader, cpty_trader }
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
fun direct_propose_accept_opens_contract() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);

    // proposer names the counterparty and fixes every term -> firm-reserves IM
    sc.next_tx(OP);
    let offer_id = {
        let mut prop = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.prop_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.prop_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        let id = direct::propose_direct<FAKE>(
            &mut prop, &cap, &allow,
            w.cpty_inst, // typed counterparty org id
            0 /*proposer long*/, string::utf8(SUI),
            100_000_000, 2_000_000, IM, 0, false, 0, 0,
            3_600_000, // offer ttl
            &clk, sc.ctx(),
        );
        // proposer IM firm-reserved at propose time
        assert!(institution::reserved_of(&prop) == IM, 1);
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(prop);
        id
    };

    // named counterparty accepts -> opens the OtcForward, re-keying the proposer leg
    sc.next_tx(OP);
    {
        let mut offer = ts::take_shared_by_id<DirectOffer<FAKE>>(&sc, offer_id);
        let mut cpty = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.cpty_inst);
        let mut prop = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.prop_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.cpty_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        direct::accept_direct<FAKE>(&mut offer, &mut cpty, &cap, &mut prop, &allow, &clk, sc.ctx());

        // both legs reserved at IM; offer accepted
        assert!(institution::reserved_of(&prop) == IM, 2);
        assert!(institution::reserved_of(&cpty) == IM, 3);
        assert!(direct::offer_status(&offer) == 1 /*ACCEPTED*/, 4);
        assert!(direct::offer_accepted_otc(&offer).is_some(), 5);

        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(prop);
        ts::return_shared(cpty);
        ts::return_shared(offer);
    };
    ts::end(sc);
}

#[test]
fun withdraw_direct_frees_proposer_im() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc);

    sc.next_tx(OP);
    let offer_id = {
        let mut prop = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.prop_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.prop_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        let id = direct::propose_direct<FAKE>(
            &mut prop, &cap, &allow, w.cpty_inst, 1 /*proposer short*/, string::utf8(SUI),
            100_000_000, 2_000_000, IM, 0, false, 0, 0, 3_600_000, &clk, sc.ctx(),
        );
        clock::destroy_for_testing(clk);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(prop);
        id
    };

    // proposer withdraws -> IM freed back to 0
    sc.next_tx(OP);
    {
        let mut offer = ts::take_shared_by_id<DirectOffer<FAKE>>(&sc, offer_id);
        let mut prop = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.prop_inst);
        let cap = ts::take_from_sender_by_id<TraderCap>(&sc, w.prop_trader);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        direct::withdraw_direct<FAKE>(&mut offer, &mut prop, &cap, &allow, sc.ctx());
        assert!(institution::reserved_of(&prop) == 0, 1);
        assert!(direct::offer_status(&offer) == 2 /*WITHDRAWN*/, 2);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(allow);
        ts::return_shared(prop);
        ts::return_shared(offer);
    };
    ts::end(sc);
}
