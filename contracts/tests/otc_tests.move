#[test_only]
module fullmetal::otc_tests;

use std::string;
use std::type_name;
use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use fullmetal::institution::{Self, Institution, AdminCap, TraderCap};
use fullmetal::oracle::{Self, RiskOracle, OracleAdminCap, KeeperCap};
use fullmetal::otc_forward::{Self, OtcForward, OtcWitness};
use fullmetal::protocol::{Self, OtcAllowlist, ProtocolCap};
use fullmetal::registry::{Self, HandleRegistry};

public struct FAKE has drop {}

const OP: address = @0x0B; // operator holds every cap in the test

// USD 1e6 scale helpers
const SUI: vector<u8> = b"SUI";

public struct World has drop {
    a_inst: ID,
    b_inst: ID,
    a_admin: ID,
    b_admin: ID,
    a_trader: ID,
    b_trader: ID,
    keeper: ID,
}

#[allow(deprecated_usage)]
fun setup(sc: &mut ts::Scenario, a_deposit: u64, b_deposit: u64): World {
    // singletons
    protocol::init_for_testing(sc.ctx());
    registry::init_for_testing(sc.ctx());
    oracle::init_for_testing(sc.ctx());

    // allowlist the OTC witness + register the SUI feed @ $2.00, 10% jump trigger
    sc.next_tx(OP);
    let keeper_id;
    {
        let mut allow = ts::take_shared<OtcAllowlist>(sc);
        let pcap = ts::take_from_sender<ProtocolCap>(sc);
        let wname = type_name::get_with_original_ids<OtcWitness>().into_string();
        protocol::allow_otc_witness(&mut allow, &pcap, wname, sc.ctx());

        let mut oracle = ts::take_shared<RiskOracle>(sc);
        let oadmin = ts::take_from_sender<OracleAdminCap>(sc);
        let clk = clock::create_for_testing(sc.ctx());
        oracle::register_feed(&mut oracle, &oadmin, string::utf8(SUI), 2_000_000, 1_000, &clk);
        let keeper = oracle::mint_keeper_cap(&oadmin, sc.ctx());
        keeper_id = object::id(&keeper);
        transfer::public_transfer(keeper, OP);
        clock::destroy_for_testing(clk);

        ts::return_to_sender(sc, pcap);
        ts::return_to_sender(sc, oadmin);
        ts::return_shared(allow);
        ts::return_shared(oracle);
    };

    let (a_inst, a_admin) = make_inst(sc, b"alice", a_deposit);
    let a_trader = grant(sc, a_inst, a_admin);
    let (b_inst, b_admin) = make_inst(sc, b"bobsec", b_deposit);
    let b_trader = grant(sc, b_inst, b_admin);

    World { a_inst, b_inst, a_admin, b_admin, a_trader, b_trader, keeper: keeper_id }
}

fun make_inst(sc: &mut ts::Scenario, handle: vector<u8>, deposit: u64): (ID, ID) {
    sc.next_tx(OP);
    let mut reg = ts::take_shared<HandleRegistry>(sc);
    let admin_cap = institution::create_institution<FAKE>(&mut reg, string::utf8(handle), sc.ctx());
    let inst_id = institution::admin_institution_id(&admin_cap);
    let admin_id = object::id(&admin_cap);
    transfer::public_transfer(admin_cap, OP);
    ts::return_shared(reg);

    // deposit
    sc.next_tx(OP);
    {
        let mut inst = ts::take_shared_by_id<Institution<FAKE>>(sc, inst_id);
        let cap = ts::take_from_sender_by_id<AdminCap>(sc, admin_id);
        let c = coin::mint_for_testing<FAKE>(deposit, sc.ctx());
        institution::deposit_treasury(&mut inst, &cap, c, sc.ctx());
        ts::return_to_sender(sc, cap);
        ts::return_shared(inst);
    };
    (inst_id, admin_id)
}

fun grant(sc: &mut ts::Scenario, inst_id: ID, admin_id: ID): ID {
    sc.next_tx(OP);
    let mut inst = ts::take_shared_by_id<Institution<FAKE>>(sc, inst_id);
    let cap = ts::take_from_sender_by_id<AdminCap>(sc, admin_id);
    // generous book size so IM reservation always fits
    let tcap = institution::grant_trader(&mut inst, &cap, OP, 1_000_000_000_000, sc.ctx());
    let tid = object::id(&tcap);
    transfer::public_transfer(tcap, OP);
    ts::return_to_sender(sc, cap);
    ts::return_shared(inst);
    tid
}

/// long=alice, short=bobsec, 100 units @ $2.00, IM $200 each, no funding.
fun open_forward(sc: &mut ts::Scenario, w: &World, im_each: u64) {
    sc.next_tx(OP);
    let mut a = ts::take_shared_by_id<Institution<FAKE>>(sc, w.a_inst);
    let mut b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let ta = ts::take_from_sender_by_id<TraderCap>(sc, w.a_trader);
    let tb = ts::take_from_sender_by_id<TraderCap>(sc, w.b_trader);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    otc_forward::open<FAKE>(
        &mut a, &ta, &mut b, &tb, &allow,
        string::utf8(SUI),
        100_000_000, // notional: 100 units (1e6)
        2_000_000, // entry $2.00
        im_each,
        0, // funding bps
        false, // funding_long_pays
        0, // settlement interval (settle anytime)
        0, // expiry (perpetual)
        &clk,
        sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, ta);
    ts::return_to_sender(sc, tb);
    ts::return_shared(allow);
    ts::return_shared(a);
    ts::return_shared(b);
}

fun push(sc: &mut ts::Scenario, keeper_id: ID, price: u64) {
    sc.next_tx(OP);
    let mut oracle = ts::take_shared<RiskOracle>(sc);
    let keeper = ts::take_from_sender_by_id<KeeperCap>(sc, keeper_id);
    let clk = clock::create_for_testing(sc.ctx());
    oracle::push_price(&mut oracle, &keeper, string::utf8(SUI), price, &clk);
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, keeper);
    ts::return_shared(oracle);
}

fun do_settle(sc: &mut ts::Scenario, w: &World) {
    sc.next_tx(OP);
    let mut fwd = ts::take_shared<OtcForward<FAKE>>(sc);
    let mut a = ts::take_shared_by_id<Institution<FAKE>>(sc, w.a_inst);
    let mut b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let oracle = ts::take_shared<RiskOracle>(sc);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    otc_forward::settle<FAKE>(&mut fwd, &mut a, &mut b, &oracle, &allow, &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(fwd);
    ts::return_shared(a);
    ts::return_shared(b);
    ts::return_shared(oracle);
    ts::return_shared(allow);
}

// ---- tests ----

#[test]
fun settle_moves_variation_margin() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000); // 1000 DBUSDC each
    open_forward(&mut sc, &w, 200_000_000); // IM $200 each
    push(&mut sc, w.keeper, 2_100_000); // +5% -> long gains $10
    do_settle(&mut sc, &w);

    // long (alice) +$10, short (bobsec) -$10
    sc.next_tx(OP);
    {
        let a = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.a_inst);
        let b = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.b_inst);
        assert!(institution::total(&a) == 1_010_000_000, 1);
        assert!(institution::total(&b) == 990_000_000, 2);
        ts::return_shared(a);
        ts::return_shared(b);
    };
    ts::end(sc);
}

#[test]
fun adverse_move_liquidates_long() {
    let mut sc = ts::begin(OP);
    // long deposits only $250 (IM $200 -> $50 free); short deposits $1000
    let w = setup(&mut sc, 250_000_000, 1_000_000_000);
    open_forward(&mut sc, &w, 200_000_000);
    push(&mut sc, w.keeper, 1_000_000); // -50% -> long loses $100 > $50 free
    do_settle(&mut sc, &w);

    sc.next_tx(OP);
    {
        let a = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.a_inst);
        let b = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.b_inst);
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        // long paid $100 out of its $250; IM released, position liquidated
        assert!(institution::total(&a) == 150_000_000, 1);
        assert!(institution::total(&b) == 1_100_000_000, 2);
        assert!(otc_forward::status(&fwd) == 2, 3); // STATUS_LIQUIDATED
        assert!(institution::reserved_of(&a) == 0, 4); // IM released on liquidation
        ts::return_shared(a);
        ts::return_shared(b);
        ts::return_shared(fwd);
    };
    ts::end(sc);
}
