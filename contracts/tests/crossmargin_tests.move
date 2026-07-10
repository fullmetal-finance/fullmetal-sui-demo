#[test_only]
/// Cross-margining tests: the maintenance-breach crank (`settle_on_breach`)
/// with its margin-call cure window, and time-pro-rata funding.
///
/// Geometry throughout: 100 units @ $2.00, IM $200/side, MM = 0.7·IM = $140,
/// so the MM BUFFER is $60 — one dollar of unrealized loss beyond it and
/// anyone may crank. Settlement interval is 1 hour; tests move the clock
/// explicitly, so the cadence path only opens when a test says so.
module fullmetal::crossmargin_tests;

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

const OP: address = @0x0B;
const SUI: vector<u8> = b"SUI";
const IM: u64 = 200_000_000; // $200 → MM $140, buffer $60
const HOUR_MS: u64 = 3_600_000;
const CURE_MS: u64 = 90_000; // must match otc_forward::CURE_WINDOW_MS

public struct World has drop {
    a_inst: ID, // long
    b_inst: ID, // short
    a_admin: ID,
    b_admin: ID,
    a_trader: ID,
    b_trader: ID,
    keeper: ID,
}

#[allow(deprecated_usage)]
fun setup(sc: &mut ts::Scenario, a_deposit: u64, b_deposit: u64): World {
    protocol::init_for_testing(sc.ctx());
    registry::init_for_testing(sc.ctx());
    oracle::init_for_testing(sc.ctx());
    sc.next_tx(OP);
    let keeper_id;
    {
        let mut allow = ts::take_shared<OtcAllowlist>(sc);
        let pcap = ts::take_from_sender<ProtocolCap>(sc);
        protocol::allow_otc_witness(&mut allow, &pcap, type_name::get_with_original_ids<OtcWitness>().into_string(), sc.ctx());
        let mut orc = ts::take_shared<RiskOracle>(sc);
        let oadmin = ts::take_from_sender<OracleAdminCap>(sc);
        let clk = clock::create_for_testing(sc.ctx());
        // high jump threshold: the vol trigger is not under test here
        oracle::register_feed(&mut orc, &oadmin, string::utf8(SUI), 2_000_000, 1_000_000, &clk);
        let keeper = oracle::mint_keeper_cap(&oadmin, sc.ctx());
        keeper_id = object::id(&keeper);
        transfer::public_transfer(keeper, OP);
        clock::destroy_for_testing(clk);
        ts::return_to_sender(sc, pcap);
        ts::return_to_sender(sc, oadmin);
        ts::return_shared(allow);
        ts::return_shared(orc);
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
    sc.next_tx(OP);
    {
        let mut inst = ts::take_shared_by_id<Institution<FAKE>>(sc, inst_id);
        let cap = ts::take_from_sender_by_id<AdminCap>(sc, admin_id);
        institution::deposit_treasury(&mut inst, &cap, coin::mint_for_testing<FAKE>(deposit, sc.ctx()), sc.ctx());
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

/// alice long / bobsec short, 100 units @ $2.00, hourly settlement, no expiry.
fun open_forward(sc: &mut ts::Scenario, w: &World, funding_bps: u64) {
    open_full(sc, w, funding_bps, HOUR_MS, 0)
}

fun open_full(sc: &mut ts::Scenario, w: &World, funding_bps: u64, interval: u64, expiry: u64) {
    sc.next_tx(OP);
    let mut a = ts::take_shared_by_id<Institution<FAKE>>(sc, w.a_inst);
    let mut b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let ta = ts::take_from_sender_by_id<TraderCap>(sc, w.a_trader);
    let tb = ts::take_from_sender_by_id<TraderCap>(sc, w.b_trader);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let clk = clock::create_for_testing(sc.ctx());
    otc_forward::open<FAKE>(
        &mut a, &ta, &mut b, &tb, &allow,
        string::utf8(SUI), 100_000_000, 2_000_000, IM,
        funding_bps, false /* short pays funding */, interval, expiry, &clk, sc.ctx(),
    );
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, ta);
    ts::return_to_sender(sc, tb);
    ts::return_shared(allow);
    ts::return_shared(a);
    ts::return_shared(b);
}

fun pause_short(sc: &mut ts::Scenario, w: &World) {
    sc.next_tx(OP);
    let mut b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let cap = ts::take_from_sender_by_id<AdminCap>(sc, w.b_admin);
    institution::pause(&mut b, &cap, sc.ctx());
    ts::return_to_sender(sc, cap);
    ts::return_shared(b);
}

fun push(sc: &mut ts::Scenario, keeper_id: ID, price: u64) {
    sc.next_tx(OP);
    let mut orc = ts::take_shared<RiskOracle>(sc);
    let keeper = ts::take_from_sender_by_id<KeeperCap>(sc, keeper_id);
    let clk = clock::create_for_testing(sc.ctx());
    oracle::push_price(&mut orc, &keeper, string::utf8(SUI), price, &clk);
    clock::destroy_for_testing(clk);
    ts::return_to_sender(sc, keeper);
    ts::return_shared(orc);
}

fun crank(sc: &mut ts::Scenario, w: &World, now_ms: u64) {
    sc.next_tx(OP);
    let mut fwd = ts::take_shared<OtcForward<FAKE>>(sc);
    let mut a = ts::take_shared_by_id<Institution<FAKE>>(sc, w.a_inst);
    let mut b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let orc = ts::take_shared<RiskOracle>(sc);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    clock::set_for_testing(&mut clk, now_ms);
    otc_forward::settle_on_breach<FAKE>(&mut fwd, &mut a, &mut b, &orc, &allow, &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(fwd);
    ts::return_shared(a);
    ts::return_shared(b);
    ts::return_shared(orc);
    ts::return_shared(allow);
}

fun plain_settle(sc: &mut ts::Scenario, w: &World, now_ms: u64) {
    sc.next_tx(OP);
    let mut fwd = ts::take_shared<OtcForward<FAKE>>(sc);
    let mut a = ts::take_shared_by_id<Institution<FAKE>>(sc, w.a_inst);
    let mut b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let orc = ts::take_shared<RiskOracle>(sc);
    let allow = ts::take_shared<OtcAllowlist>(sc);
    let mut clk = clock::create_for_testing(sc.ctx());
    clock::set_for_testing(&mut clk, now_ms);
    otc_forward::settle<FAKE>(&mut fwd, &mut a, &mut b, &orc, &allow, &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(fwd);
    ts::return_shared(a);
    ts::return_shared(b);
    ts::return_shared(orc);
    ts::return_shared(allow);
}

fun totals(sc: &ts::Scenario, w: &World): (u64, u64) {
    let a = ts::take_shared_by_id<Institution<FAKE>>(sc, w.a_inst);
    let b = ts::take_shared_by_id<Institution<FAKE>>(sc, w.b_inst);
    let ta = institution::total(&a);
    let tb = institution::total(&b);
    ts::return_shared(a);
    ts::return_shared(b);
    (ta, tb)
}

// --- tests -----------------------------------------------------------

#[test]
fun breach_crank_pool_covers_and_position_survives() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_forward(&mut sc, &w, 0);
    // +35%: short's unrealized loss $70 > $60 buffer → crankable
    push(&mut sc, w.keeper, 2_700_000);

    sc.next_tx(OP);
    {
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        let orc = ts::take_shared<RiskOracle>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        assert!(otc_forward::mm_buffer(&fwd) == 60_000_000, 1);
        assert!(otc_forward::mm_breached(&fwd, &orc, &clk), 2);
        clock::destroy_for_testing(clk);
        ts::return_shared(orc);
        ts::return_shared(fwd);
    };

    crank(&mut sc, &w, 0);

    // THE CROSS-MARGIN GRACE: short's pool covered $70 with zero margin-call
    // latency; the position re-marks at $2.70 and SURVIVES.
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        assert!(ta == 1_070_000_000 && tb == 930_000_000, 3);
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        let orc = ts::take_shared<RiskOracle>(&sc);
        let clk = clock::create_for_testing(sc.ctx());
        assert!(otc_forward::status(&fwd) == 0, 4); // ACTIVE
        assert!(otc_forward::mark(&fwd) == 2_700_000, 5); // re-marked
        assert!(!otc_forward::mm_breached(&fwd, &orc, &clk), 6); // healthy again
        assert!(option::is_none(&otc_forward::margin_call_deadline(&fwd)), 7);
        clock::destroy_for_testing(clk);
        ts::return_shared(orc);
        ts::return_shared(fwd);
    };
    ts::end(sc);
}

#[test]
fun insolvent_breach_calls_then_liquidates_after_cure_window() {
    let mut sc = ts::begin(OP);
    // short is thin: $210 equity backing a $200 IM fence → $10 free
    let w = setup(&mut sc, 1_000_000_000, 210_000_000);
    open_forward(&mut sc, &w, 0);
    // +125%: short owes $250 — more than its whole treasury
    push(&mut sc, w.keeper, 4_500_000);

    // crank #1: NOT terminal — records the margin call, changes nothing else
    crank(&mut sc, &w, 0);
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        assert!(ta == 1_000_000_000 && tb == 210_000_000, 10); // untouched
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        assert!(otc_forward::status(&fwd) == 0, 11); // still ACTIVE
        let dl = otc_forward::margin_call_deadline(&fwd);
        assert!(option::is_some(&dl) && *option::borrow(&dl) == CURE_MS, 12);
        ts::return_shared(fwd);
    };

    // crank #2 after the window, breach uncured → terminal
    crank(&mut sc, &w, CURE_MS);
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        // recovery = min(owed $250, everything short has once fences release)
        assert!(ta == 1_210_000_000 && tb == 0, 13);
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        assert!(otc_forward::status(&fwd) == 2, 14); // LIQUIDATED
        ts::return_shared(fwd);
    };
    sc.next_tx(OP);
    {
        let a = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.a_inst);
        let b = ts::take_shared_by_id<Institution<FAKE>>(&sc, w.b_inst);
        assert!(institution::reserved_of(&a) == 0 && institution::reserved_of(&b) == 0, 15);
        ts::return_shared(a);
        ts::return_shared(b);
    };
    ts::end(sc);
}

#[test]
#[expected_failure] // ECureWindowActive: cannot liquidate inside the cure window
fun liquidation_inside_cure_window_aborts() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 210_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 4_500_000);
    crank(&mut sc, &w, 0); // margin call
    crank(&mut sc, &w, CURE_MS - 1); // one ms early → abort
    ts::end(sc);
}

#[test]
fun wick_that_reverts_clears_the_call_no_liquidation() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 210_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 2_700_000); // wick: short owes $70 > $10 free
    crank(&mut sc, &w, 0); // margin call recorded at the wick
    push(&mut sc, w.keeper, 2_000_000); // ...and the wick reverts (healthy again)
    // a crank on the now-healthy position CLEARS the stale call rather than
    // liquidating off it — even though the window has elapsed. No fresh breach,
    // no liquidation; the position is untouched.
    crank(&mut sc, &w, CURE_MS);
    sc.next_tx(OP);
    {
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        assert!(otc_forward::status(&fwd) == 0, 40); // ACTIVE
        assert!(option::is_none(&otc_forward::margin_call_deadline(&fwd)), 41); // call gone
        ts::return_shared(fwd);
    };
    ts::end(sc);
}

#[test]
fun cured_call_is_cleared_by_next_settlement_not_sticky() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 210_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 2_700_000);
    crank(&mut sc, &w, 0); // margin call at the wick
    push(&mut sc, w.keeper, 2_000_000); // reverts
    plain_settle(&mut sc, &w, HOUR_MS); // cadence settle: net 0, clears the call

    // a NEW wick later must start a FRESH call — not liquidate off the stale one
    push(&mut sc, w.keeper, 2_700_000);
    crank(&mut sc, &w, HOUR_MS + 1);
    sc.next_tx(OP);
    {
        let fwd = ts::take_shared<OtcForward<FAKE>>(&sc);
        assert!(otc_forward::status(&fwd) == 0, 20); // ACTIVE — called, not killed
        let dl = otc_forward::margin_call_deadline(&fwd);
        assert!(option::is_some(&dl) && *option::borrow(&dl) == HOUR_MS + 1 + CURE_MS, 21);
        ts::return_shared(fwd);
    };
    ts::end(sc);
}

#[test]
#[expected_failure] // EHealthy: unrealized loss $50 ≤ $60 buffer — no harassment
fun healthy_position_cannot_be_cranked() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 2_500_000); // +25% → loss $50, inside the buffer
    crank(&mut sc, &w, 0);
    ts::end(sc);
}

#[test]
#[expected_failure] // ENotDueYet: the cadence gate is untouched by the crank's existence
fun cadence_settle_still_blocked_mid_interval() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 2_700_000);
    plain_settle(&mut sc, &w, HOUR_MS - 1); // one ms early → abort
    ts::end(sc);
}

#[test]
#[expected_failure] // ENotDueYet: a breach settlement restarts the interval clock
fun breach_settle_does_not_unlock_cadence() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 2_700_000);
    crank(&mut sc, &w, 1_800_000); // settles $70 at t=30m through the breach gate
    plain_settle(&mut sc, &w, HOUR_MS); // next cadence is 30m+1h → still shut at 1h
    ts::end(sc);
}

/// Funding is pro-rata in elapsed time, so any crank sequence TELESCOPES to
/// exactly the single-settlement charge — the confirmed over-collection attack
/// (bill one full funding per crank, K per interval) nets to zero extra.
#[test]
fun funding_pro_rata_telescopes_across_cranks() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    // 300 bps per hourly interval on $200 notional = $6/interval, short pays
    open_forward(&mut sc, &w, 300);

    // leg 1: +35% at t=30m. VM $70 + funding $6·(30m/1h)=$3 → short pays $73
    push(&mut sc, w.keeper, 2_700_000);
    crank(&mut sc, &w, 1_800_000);
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        assert!(ta == 1_073_000_000 && tb == 927_000_000, 30);
    };

    // leg 2: +35% more at t=60m. VM $70 + funding $3 (remaining half-interval)
    push(&mut sc, w.keeper, 3_400_000);
    crank(&mut sc, &w, HOUR_MS);
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        // two cranks total $146 == one hypothetical single settle at t=60m
        // @3.40: VM $140 + one full funding $6. No leak from crank count.
        assert!(ta == 1_146_000_000 && tb == 854_000_000, 31);
    };
    ts::end(sc);
}

/// A losing desk cannot dodge settlement by pausing itself: settlement honors an
/// existing obligation and is pause-exempt. (Pause still blocks the desk's own
/// withdrawals / new contracts.)
#[test]
fun paused_loser_still_settles() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_forward(&mut sc, &w, 0);
    push(&mut sc, w.keeper, 2_300_000); // +15% -> short owes $30, well within its pool
    pause_short(&mut sc, &w); // loser freezes itself to try to escape the mark
    plain_settle(&mut sc, &w, HOUR_MS); // must STILL move the VM
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        assert!(ta == 1_030_000_000 && tb == 970_000_000, 50);
    };
    ts::end(sc);
}

#[test]
#[expected_failure] // EExpiredUseClose: past expiry, close() is the only terminal path
fun settle_after_expiry_aborts() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_full(&mut sc, &w, 0, HOUR_MS, HOUR_MS); // expires at 1h
    push(&mut sc, w.keeper, 2_100_000);
    plain_settle(&mut sc, &w, HOUR_MS + 1); // one ms past expiry -> abort
    ts::end(sc);
}

/// A settle-anytime (interval 0) contract carries NO periodic funding — there is
/// no period to pro-rate — so repeated same-price settles move nothing (the old
/// per-call funding leak is closed).
#[test]
fun interval_zero_charges_no_funding() {
    let mut sc = ts::begin(OP);
    let w = setup(&mut sc, 1_000_000_000, 1_000_000_000);
    open_full(&mut sc, &w, 300, 0, 0); // funding 300 bps requested, but interval 0
    // price flat at entry: VM 0, and funding must be 0 despite the 300 bps
    plain_settle(&mut sc, &w, 0);
    plain_settle(&mut sc, &w, 0);
    plain_settle(&mut sc, &w, 0);
    sc.next_tx(OP);
    {
        let (ta, tb) = totals(&sc, &w);
        assert!(ta == 1_000_000_000 && tb == 1_000_000_000, 60); // nothing moved
    };
    ts::end(sc);
}