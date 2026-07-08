#[test_only]
/// Tests for the risk-responsive layer: the EWMA volatility trigger with
/// hysteresis (oracle) and the liquidity-floor + hot-potato venue router.
/// Numbers mirror RISK-RESPONSIVE-REHYPOTHECATION.md §1/§2 worked examples.
module fullmetal::risk_tests;

use std::string;
use sui::clock;
use sui::coin;
use sui::test_scenario as ts;
use fullmetal::institution::{Self, Institution, AdminCap};
use fullmetal::oracle::{Self, RiskOracle, OracleAdminCap, KeeperCap};
use fullmetal::registry::{Self, HandleRegistry};
use fullmetal::rehypo_router as router;

const ADMIN: address = @0xA;

public struct FAKE has drop {}

/// Stand-in for a venue receipt (SupplierCap / CToken / AccountCap).
public struct FakeReceipt has store {}

// --- helpers -------------------------------------------------------

fun spcx(): string::String { string::utf8(b"SPCX") }

/// Oracle + keeper + SPCX feed at $185, legacy jump latch disabled (1e6 bps)
/// so only the EWMA paths latch. Returns nothing; objects live in the scenario.
fun setup_oracle(sc: &mut ts::Scenario, jump_threshold_bps: u64) {
    oracle::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    {
        let mut orc = ts::take_shared<RiskOracle>(sc);
        let admin = ts::take_from_sender<OracleAdminCap>(sc);
        let clk = clock::create_for_testing(sc.ctx());
        oracle::register_feed(&mut orc, &admin, spcx(), 185_000_000, jump_threshold_bps, &clk);
        let keeper = oracle::mint_keeper_cap(&admin, sc.ctx());
        transfer::public_transfer(keeper, ADMIN);
        clock::destroy_for_testing(clk);
        ts::return_to_sender(sc, admin);
        ts::return_shared(orc);
    };
}

/// Push a price via v2 as the keeper. `pct_x100` is the signed move in
/// hundredths of a percent (e.g. 1500 = +15.00%, -50 = -0.50%).
fun push_pct(sc: &mut ts::Scenario, pct_x100: u64, up: bool) {
    let mut orc = ts::take_shared<RiskOracle>(sc);
    let keeper = ts::take_from_sender<KeeperCap>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    let prev = oracle::price(&orc, spcx());
    let delta = prev / 10_000 * pct_x100;
    let next = if (up) prev + delta else prev - delta;
    oracle::push_price_v2(&mut orc, &keeper, spcx(), next, &clk);
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, keeper);
    ts::return_shared(orc);
}

fun assert_triggered(sc: &ts::Scenario, want: bool) {
    let orc = ts::take_shared<RiskOracle>(sc);
    assert!(oracle::is_triggered(&orc, spcx()) == want, 999);
    ts::return_shared(orc);
}

/// σ seed 200bps, λ=0.94, z*=4.0, ceil=800bps, release deadband 0.7, N=3.
fun enable_default_vol(sc: &mut ts::Scenario) {
    let mut orc = ts::take_shared<RiskOracle>(sc);
    let admin = ts::take_from_sender<OracleAdminCap>(sc);
    oracle::enable_vol(&mut orc, &admin, spcx(), 200, 9_400, 400, 800, 7_000, 3);
    ts::return_to_sender(sc, admin);
    ts::return_shared(orc);
}

/// Institution with `amount` deposited. AdminCap ends up with ADMIN.
fun setup_institution(sc: &mut ts::Scenario, amount: u64) {
    registry::init_for_testing(sc.ctx());
    sc.next_tx(ADMIN);
    {
        let mut reg = ts::take_shared<HandleRegistry>(sc);
        let cap = institution::create_institution<FAKE>(&mut reg, string::utf8(b"acme"), sc.ctx());
        transfer::public_transfer(cap, ADMIN);
        ts::return_shared(reg);
    };
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(sc);
        let cap = ts::take_from_sender<AdminCap>(sc);
        institution::deposit_treasury(&mut inst, &cap, coin::mint_for_testing<FAKE>(amount, sc.ctx()), sc.ctx());
        ts::return_to_sender(sc, cap);
        ts::return_shared(inst);
    };
}

// --- oracle: EWMA + hysteresis --------------------------------------

#[test]
fun vol_shock_latches_then_hysteresis_releases() {
    let mut sc = ts::begin(ADMIN);
    setup_oracle(&mut sc, 1_000_000); // legacy jump latch off
    sc.next_tx(ADMIN);
    enable_default_vol(&mut sc);

    // calm print: +0.50% vs σ=200bps is z=0.25 — no latch
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 50, true);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, false);

    // shock: +15% vs σ≈194bps is z≈7.7 > 4 — latches
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 1_500, true);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, true);

    // post-shock σ≈372bps < release band (0.7·800=560): three calm prints unlatch
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 10, false);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, true); // 1 of 3
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 10, true);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, true); // 2 of 3
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 10, false);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, false); // 3rd calm print auto-releases
    sc.end();
}

#[test]
fun vol_release_counter_resets_on_new_shock() {
    let mut sc = ts::begin(ADMIN);
    setup_oracle(&mut sc, 1_000_000);
    sc.next_tx(ADMIN);
    enable_default_vol(&mut sc);

    sc.next_tx(ADMIN);
    push_pct(&mut sc, 1_500, true); // latch
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 10, true); // release 1/3
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 10, false); // release 2/3
    sc.next_tx(ADMIN);
    {
        let orc = ts::take_shared<RiskOracle>(&sc);
        assert!(oracle::release_progress(&orc, spcx()) == 2, 100);
        ts::return_shared(orc);
    };
    // fresh shock: z vs σ≈350bps for a 20% print ≈ 5.7 > 4 — re-latch, counter resets
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 2_000, true);
    sc.next_tx(ADMIN);
    {
        let orc = ts::take_shared<RiskOracle>(&sc);
        assert!(oracle::release_progress(&orc, spcx()) == 0, 101);
        assert!(oracle::is_triggered(&orc, spcx()), 102);
        ts::return_shared(orc);
    };
    // the bigger shock left σ≈619bps — ABOVE the 560 release band, so calm
    // prints don't count until σ itself decays back under it (~3 prints), and
    // only then does the 3-print counter run: release lands on the 6th print.
    // Bigger shock ⇒ longer cool-down, from the same two rules.
    let mut i = 0;
    while (i < 5) {
        sc.next_tx(ADMIN);
        push_pct(&mut sc, 10, i % 2 == 0);
        sc.next_tx(ADMIN);
        assert_triggered(&sc, true);
        i = i + 1;
    };
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 10, true); // 6th calm print
    sc.next_tx(ADMIN);
    assert_triggered(&sc, false);
    sc.end();
}

#[test]
fun vol_regime_ceiling_latches_without_single_shock() {
    let mut sc = ts::begin(ADMIN);
    setup_oracle(&mut sc, 1_000_000);
    // z* effectively off (10_000σ), seed σ=750, ceil=800: only the regime path can latch
    sc.next_tx(ADMIN);
    {
        let mut orc = ts::take_shared<RiskOracle>(&sc);
        let admin = ts::take_from_sender<OracleAdminCap>(&sc);
        oracle::enable_vol(&mut orc, &admin, spcx(), 750, 9_400, 1_000_000, 800, 7_000, 3);
        ts::return_to_sender(&sc, admin);
        ts::return_shared(orc);
    };
    // +12% print: σ 750 → ~784, still under the 800 ceiling
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 1_200, true);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, false);
    // second +12%: σ ~784 → ~815 > 800 — slow bleed latches with no single 4σ print
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 1_200, false);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, true);
    sc.end();
}

#[test]
fun push_v2_without_vol_state_keeps_legacy_behavior() {
    let mut sc = ts::begin(ADMIN);
    setup_oracle(&mut sc, 1_500); // legacy 15% jump latch, NO enable_vol
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 500, true); // +5% — under threshold
    sc.next_tx(ADMIN);
    assert_triggered(&sc, false);
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 1_600, true); // +16% — legacy latch fires through v2
    sc.next_tx(ADMIN);
    assert_triggered(&sc, true);
    sc.next_tx(ADMIN);
    {
        let orc = ts::take_shared<RiskOracle>(&sc);
        assert!(!oracle::has_vol(&orc, spcx()), 103);
        assert!(oracle::vol_bps(&orc, spcx()) == 0, 104);
        ts::return_shared(orc);
    };
    sc.end();
}

// --- router: floor + tickets + caps ---------------------------------

#[test]
fun ticket_roundtrip_supply_then_recall_accounting() {
    let mut sc = ts::begin(ADMIN);
    setup_institution(&mut sc, 1_000);

    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let cap = ts::take_from_sender<AdminCap>(&sc);
        let v = router::venue_suilend();

        // supply leg: 400 out, receipt stored, mirror credited
        let (coin_out, ticket) = router::withdraw_for_rehypo(&mut inst, &cap, v, 400, sc.ctx());
        assert!(coin::value(&coin_out) == 400, 200);
        router::confirm_rehypo(&mut inst, ticket, option::some(FakeReceipt {}), sc.ctx());
        assert!(institution::total(&inst) == 600, 201); // liquid dropped
        assert!(institution::equity(&inst) == 1_000, 202); // equity unchanged
        assert!(institution::rehypothecated_of(&inst) == 400, 203);
        assert!(router::principal_of(&inst, v) == 400, 204);

        // recall leg: receipt comes back out, funds + interest rejoin treasury
        let (receipt, rticket) = router::begin_recall<FAKE, FakeReceipt>(&mut inst, &cap, v);
        let FakeReceipt {} = receipt;
        // venue returned principal + 5 interest (interest realizes into equity)
        let mut back = coin_out;
        coin::join(&mut back, coin::mint_for_testing<FAKE>(5, sc.ctx()));
        router::finish_recall(&mut inst, rticket, back, sc.ctx());
        assert!(institution::total(&inst) == 1_005, 205);
        assert!(institution::rehypothecated_of(&inst) == 0, 206);
        assert!(router::principal_of(&inst, v) == 0, 207);

        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
    };
    sc.end();
}

#[test]
#[expected_failure] // EBelowLiquidityFloor: deploy would breach T ≥ F
fun floor_blocks_deploy() {
    let mut sc = ts::begin(ADMIN);
    setup_institution(&mut sc, 1_000);
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let cap = ts::take_from_sender<AdminCap>(&sc);
        // keeper says stressed outflow over the recall horizon is 900
        router::set_liquidity_floor(&mut inst, &cap, 900, 2_500);
        assert!(router::required_floor(&inst) == 900, 300);
        assert!(router::deployable(&inst) == 100, 301);
        // 200 > deployable → abort
        let (c, t) = router::withdraw_for_rehypo(&mut inst, &cap, router::venue_navi(), 200, sc.ctx());
        router::confirm_rehypo(&mut inst, t, option::some(FakeReceipt {}), sc.ctx());
        transfer::public_transfer(c, ADMIN);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
    };
    sc.end();
}

#[test]
fun floor_allows_deploy_up_to_surplus() {
    let mut sc = ts::begin(ADMIN);
    setup_institution(&mut sc, 1_000);
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let cap = ts::take_from_sender<AdminCap>(&sc);
        router::set_liquidity_floor(&mut inst, &cap, 900, 2_500);
        // exactly the surplus is fine: T'=900 = F
        let (c, t) = router::withdraw_for_rehypo(&mut inst, &cap, router::venue_navi(), 100, sc.ctx());
        router::confirm_rehypo(&mut inst, t, option::some(FakeReceipt {}), sc.ctx());
        transfer::public_transfer(c, ADMIN);
        assert!(institution::total(&inst) == 900, 302);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
    };
    sc.end();
}

#[test]
#[expected_failure] // EOverBookSize: venue principal cap exceeded
fun venue_cap_blocks_oversize_deploy() {
    let mut sc = ts::begin(ADMIN);
    setup_institution(&mut sc, 1_000);
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let cap = ts::take_from_sender<AdminCap>(&sc);
        router::set_venue_config(&mut inst, &cap, router::venue_deepbook(), true, 100, 5_000);
        let (c, t) = router::withdraw_for_rehypo(&mut inst, &cap, router::venue_deepbook(), 200, sc.ctx());
        router::confirm_rehypo(&mut inst, t, option::some(FakeReceipt {}), sc.ctx());
        transfer::public_transfer(c, ADMIN);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
    };
    sc.end();
}

#[test]
fun collateral_params_set_and_read() {
    let mut sc = ts::begin(ADMIN);
    setup_institution(&mut sc, 1_000);
    sc.next_tx(ADMIN);
    {
        let mut inst = ts::take_shared<Institution<FAKE>>(&sc);
        let cap = ts::take_from_sender<AdminCap>(&sc);
        // defaults before any write
        let (im, mm, trig) = router::collateral_params(&inst);
        assert!(im == 500 && mm == 350 && trig == 1_500, 400);
        // firm tightens its own policy — the "change the collateral ratio" path
        router::set_collateral_params(&mut inst, &cap, 800, 560, 1_200);
        let (im2, mm2, trig2) = router::collateral_params(&inst);
        assert!(im2 == 800 && mm2 == 560 && trig2 == 1_200, 401);
        ts::return_to_sender(&sc, cap);
        ts::return_shared(inst);
    };
    sc.end();
}

#[test]
fun vol_is_retunable_and_disablable() {
    let mut sc = ts::begin(ADMIN);
    setup_oracle(&mut sc, 1_000_000); // legacy jump latch off
    sc.next_tx(ADMIN);
    enable_default_vol(&mut sc); // seed σ 200bps, z* 4, ceil 800
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 50, true); // one calm print, σ well-defined

    // retune the shock latch down to z* = 2 in place
    sc.next_tx(ADMIN);
    {
        let mut orc = ts::take_shared<RiskOracle>(&sc);
        let admin = ts::take_from_sender<OracleAdminCap>(&sc);
        oracle::retune_vol(&mut orc, &admin, spcx(), 9_400, 200, 800, 7_000, 3);
        ts::return_to_sender(&sc, admin);
        ts::return_shared(orc);
    };
    // +6% vs σ≈2% is z≈3: no latch under old z*=4, latches under the new z*=2
    sc.next_tx(ADMIN);
    push_pct(&mut sc, 600, true);
    sc.next_tx(ADMIN);
    assert_triggered(&sc, true);

    // disable reverts the feed to legacy behaviour (vol state removed)
    sc.next_tx(ADMIN);
    {
        let mut orc = ts::take_shared<RiskOracle>(&sc);
        let admin = ts::take_from_sender<OracleAdminCap>(&sc);
        oracle::clear_trigger(&mut orc, &admin, spcx());
        oracle::disable_vol(&mut orc, &admin, spcx());
        assert!(!oracle::has_vol(&orc, spcx()), 500);
        ts::return_to_sender(&sc, admin);
        ts::return_shared(orc);
    };
    sc.end();
}