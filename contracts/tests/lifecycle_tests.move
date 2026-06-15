#[test_only]
module fullmetal::lifecycle_tests;

use std::string;
use std::type_name;
use sui::coin;
use sui::test_scenario as ts;
use fullmetal::institution::{Self, Institution, AdminCap, TraderCap};
use fullmetal::protocol::{Self, OtcAllowlist, ProtocolCap};
use fullmetal::registry::{Self, HandleRegistry};

const ADMIN: address = @0xA;
const ADMIN_B: address = @0xB;
const TRADER: address = @0x7;

/// Test collateral type (phantom C) and OTC witnesses.
public struct FAKE has drop {}
public struct TEST_OTC has drop {}
public struct BAD_OTC has drop {}

// --- helpers -------------------------------------------------------

fun init_singletons(sc: &mut ts::Scenario) {
    protocol::init_for_testing(sc.ctx());
    registry::init_for_testing(sc.ctx());
}

#[allow(deprecated_usage)]
fun allowlist_test_otc(sc: &mut ts::Scenario) {
    let mut allow = ts::take_shared<OtcAllowlist>(sc);
    let pcap = ts::take_from_sender<ProtocolCap>(sc);
    let wname = type_name::get_with_original_ids<TEST_OTC>().into_string();
    protocol::allow_otc_witness(&mut allow, &pcap, wname, sc.ctx());
    ts::return_to_sender(sc, pcap);
    ts::return_shared(allow);
}

/// Create an institution with `handle`, transfer the AdminCap to `admin`,
/// and return the institution's ID.
fun create(sc: &mut ts::Scenario, admin: address, handle: vector<u8>): ID {
    let mut reg = ts::take_shared<HandleRegistry>(sc);
    let admin_cap = institution::create_institution<FAKE>(&mut reg, string::utf8(handle), sc.ctx());
    let id = institution::admin_institution_id(&admin_cap);
    transfer::public_transfer(admin_cap, admin);
    ts::return_shared(reg);
    id
}

// --- tests ---------------------------------------------------------

#[test]
fun lifecycle_happy_path() {
    let mut sc = ts::begin(ADMIN);
    init_singletons(&mut sc);

    sc.next_tx(ADMIN);
    allowlist_test_otc(&mut sc);

    sc.next_tx(ADMIN);
    create(&mut sc, ADMIN, b"acme");

    // deposit + grant trader
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let admin_cap = ts::take_from_sender<AdminCap>(&sc);
        let c = coin::mint_for_testing<FAKE>(1_000_000, sc.ctx());
        institution::deposit_treasury(&mut inst, &admin_cap, c, sc.ctx());
        assert!(institution::total(&inst) == 1_000_000, 100);
        assert!(institution::available(&inst) == 1_000_000, 101);

        let tcap = institution::grant_trader(&mut inst, &admin_cap, TRADER, 600_000, sc.ctx());
        assert!(institution::trader_remaining(&inst, TRADER) == 600_000, 102);
        transfer::public_transfer(tcap, TRADER);
        ts::return_to_sender(&sc, admin_cap);
        ts::return_shared(inst);
    };

    // trader reserves initial margin through the witness seam
    sc.next_tx(TRADER);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let tcap = ts::take_from_sender<TraderCap>(&sc);
        let otc_id = object::id_from_address(@0xC0);
        let cpty = object::id_from_address(@0xB);
        institution::reserve_margin<FAKE, TEST_OTC>(
            &mut inst,
            TEST_OTC {},
            &allow,
            &tcap,
            otc_id,
            cpty,
            400_000, // IM
            280_000, // maintenance (70% of IM)
        );
        assert!(institution::reserved_of(&inst) == 400_000, 110);
        assert!(institution::available(&inst) == 600_000, 111); // IM fenced, not moved
        assert!(institution::trader_remaining(&inst, TRADER) == 200_000, 112);
        assert!(institution::total_required_of(&inst) == 280_000, 113);
        ts::return_to_sender(&sc, tcap);
        ts::return_shared(allow);
        ts::return_shared(inst);
    };

    // release the contract (any caller with the OTC witness)
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let otc_id = object::id_from_address(@0xC0);
        institution::release_margin<FAKE, TEST_OTC>(&mut inst, TEST_OTC {}, &allow, otc_id);
        assert!(institution::reserved_of(&inst) == 0, 120);
        assert!(institution::available(&inst) == 1_000_000, 121);
        assert!(institution::total_required_of(&inst) == 0, 122);
        ts::return_shared(allow);
        ts::return_shared(inst);
    };

    // admin withdraws the now-unencumbered treasury
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let admin_cap = ts::take_from_sender<AdminCap>(&sc);
        let c = institution::withdraw_treasury(&mut inst, &admin_cap, 1_000_000, sc.ctx());
        assert!(coin::burn_for_testing(c) == 1_000_000, 130);
        assert!(institution::total(&inst) == 0, 131);
        ts::return_to_sender(&sc, admin_cap);
        ts::return_shared(inst);
    };

    ts::end(sc);
}

#[test]
fun settlement_moves_funds_between_institutions() {
    let mut sc = ts::begin(ADMIN);
    init_singletons(&mut sc);

    sc.next_tx(ADMIN);
    allowlist_test_otc(&mut sc);

    sc.next_tx(ADMIN);
    let a_id = create(&mut sc, ADMIN, b"acme");

    sc.next_tx(ADMIN_B);
    let b_id = create(&mut sc, ADMIN_B, b"beta");

    // fund A
    sc.next_tx(ADMIN);
    {
        let mut a = ts::take_shared_by_id<Institution<FAKE>>(&sc, a_id);
        let cap = ts::take_from_sender<AdminCap>(&sc);
        let c = coin::mint_for_testing<FAKE>(1_000_000, sc.ctx());
        institution::deposit_treasury(&mut a, &cap, c, sc.ctx());
        ts::return_to_sender(&sc, cap);
        ts::return_shared(a);
    };

    // settle 250_000 from A to B atomically
    sc.next_tx(ADMIN);
    {
        let mut a = ts::take_shared_by_id<Institution<FAKE>>(&sc, a_id);
        let mut b = ts::take_shared_by_id<Institution<FAKE>>(&sc, b_id);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let otc_id = object::id_from_address(@0xC0);
        let ticket = fullmetal::settlement::begin_settlement<FAKE, TEST_OTC>(
            &mut a,
            TEST_OTC {},
            &allow,
            b_id,
            otc_id,
            250_000,
        );
        fullmetal::settlement::finish_settlement<FAKE>(&mut b, ticket, sc.ctx());
        assert!(institution::total(&a) == 750_000, 200);
        assert!(institution::total(&b) == 250_000, 201);
        ts::return_shared(allow);
        ts::return_shared(a);
        ts::return_shared(b);
    };

    ts::end(sc);
}

#[test]
#[expected_failure] // EWouldUnderfundReserved: cannot withdraw fenced IM
fun cannot_withdraw_reserved_margin() {
    let mut sc = ts::begin(ADMIN);
    init_singletons(&mut sc);
    sc.next_tx(ADMIN);
    allowlist_test_otc(&mut sc);
    sc.next_tx(ADMIN);
    create(&mut sc, ADMIN, b"acme");

    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let admin_cap = ts::take_from_sender<AdminCap>(&sc);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let c = coin::mint_for_testing<FAKE>(1_000_000, sc.ctx());
        institution::deposit_treasury(&mut inst, &admin_cap, c, sc.ctx());
        let tcap = institution::grant_trader(&mut inst, &admin_cap, TRADER, 600_000, sc.ctx());
        institution::reserve_margin<FAKE, TEST_OTC>(
            &mut inst, TEST_OTC {}, &allow, &tcap,
            object::id_from_address(@0xC0), object::id_from_address(@0xB),
            400_000, 280_000,
        );
        // available is 600_000; this must abort
        let c2 = institution::withdraw_treasury(&mut inst, &admin_cap, 700_000, sc.ctx());
        coin::burn_for_testing(c2);
        transfer::public_transfer(tcap, TRADER);
        ts::return_to_sender(&sc, admin_cap);
        ts::return_shared(allow);
        ts::return_shared(inst);
    };
    ts::end(sc);
}

#[test]
#[expected_failure] // EOverBookSize: reservation beyond trader book size
fun cannot_reserve_beyond_book_size() {
    let mut sc = ts::begin(ADMIN);
    init_singletons(&mut sc);
    sc.next_tx(ADMIN);
    allowlist_test_otc(&mut sc);
    sc.next_tx(ADMIN);
    create(&mut sc, ADMIN, b"acme");

    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let admin_cap = ts::take_from_sender<AdminCap>(&sc);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let c = coin::mint_for_testing<FAKE>(1_000_000, sc.ctx());
        institution::deposit_treasury(&mut inst, &admin_cap, c, sc.ctx());
        let tcap = institution::grant_trader(&mut inst, &admin_cap, TRADER, 300_000, sc.ctx());
        // 400_000 > book size 300_000 -> abort
        institution::reserve_margin<FAKE, TEST_OTC>(
            &mut inst, TEST_OTC {}, &allow, &tcap,
            object::id_from_address(@0xC0), object::id_from_address(@0xB),
            400_000, 280_000,
        );
        transfer::public_transfer(tcap, TRADER);
        ts::return_to_sender(&sc, admin_cap);
        ts::return_shared(allow);
        ts::return_shared(inst);
    };
    ts::end(sc);
}

#[test]
#[expected_failure] // EWitnessNotAllowed: BAD_OTC never allowlisted
fun cannot_reserve_with_unlisted_witness() {
    let mut sc = ts::begin(ADMIN);
    init_singletons(&mut sc);
    sc.next_tx(ADMIN);
    allowlist_test_otc(&mut sc);
    sc.next_tx(ADMIN);
    create(&mut sc, ADMIN, b"acme");

    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let admin_cap = ts::take_from_sender<AdminCap>(&sc);
        let allow = ts::take_shared<OtcAllowlist>(&sc);
        let c = coin::mint_for_testing<FAKE>(1_000_000, sc.ctx());
        institution::deposit_treasury(&mut inst, &admin_cap, c, sc.ctx());
        let tcap = institution::grant_trader(&mut inst, &admin_cap, TRADER, 600_000, sc.ctx());
        // BAD_OTC is a valid drop witness but not on the allowlist -> abort
        institution::reserve_margin<FAKE, BAD_OTC>(
            &mut inst, BAD_OTC {}, &allow, &tcap,
            object::id_from_address(@0xC0), object::id_from_address(@0xB),
            100_000, 70_000,
        );
        transfer::public_transfer(tcap, TRADER);
        ts::return_to_sender(&sc, admin_cap);
        ts::return_shared(allow);
        ts::return_shared(inst);
    };
    ts::end(sc);
}

#[test]
#[expected_failure] // EHandleTaken: duplicate handle
fun handle_uniqueness_enforced() {
    let mut sc = ts::begin(ADMIN);
    init_singletons(&mut sc);
    sc.next_tx(ADMIN);
    create(&mut sc, ADMIN, b"acme");
    sc.next_tx(ADMIN_B);
    create(&mut sc, ADMIN_B, b"acme"); // same handle -> abort
    ts::end(sc);
}
