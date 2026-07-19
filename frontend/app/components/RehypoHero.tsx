"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import { DBUSDC_TYPE, DEEPBOOK, SPCX, SPCX_VOL, TARGET, explorer, usd } from "@/lib/fullmetal";
import type { InstState } from "@/lib/institution-state";
import { readFloor, readInstitution, readSuppliedValue } from "@/lib/institution-state";
import { cureCalls, friendlyMoveError, oracleStatus, pushTick, resetOracle, triggerAndRecall, type OracleResult } from "@/lib/oracle";
import { FLOW, STATUS, VENUE_ACCENT } from "@/lib/palette";
import { useRates } from "@/lib/rates";
import { useRecall, useRehypothecate } from "@/lib/rehypo-actions";
import { useSponsoredExecute } from "@/lib/sponsored";
import { suiRead } from "@/lib/sui";
import { createMarketSim, type MarketEventKind, type MarketSim } from "@/lib/scenario";
import { loadSimVenues, simAccrued, simDeposit, simValue, simWithdraw, simWithdrawAll, type SimVenues } from "@/lib/venues";
import ScenarioChart, { type ChartEvent, type ChartPoint } from "./ScenarioChart";

type Flow = -1 | 0 | 1;
type VenueKey = "deepbook" | "suilend" | "navi";

const WINDOW = 48; // rolling chart window (prints)
const CADENCE_MS = 1500; // min gap between prints (tx latency usually dominates)

export default function RehypoHero({
  instId,
  adminCapId,
  state,
  otcIds = [],
  onRefresh,
}: {
  instId: string;
  /** the desk admin's cap — enables the on-chain floor-policy control */
  adminCapId?: string;
  state: InstState | null;
  /** the desk's OPEN, unexpired contracts — armed into crash ticks so the
   *  breach crank fires while liquidity is out (margin call → cure → survive) */
  otcIds?: string[];
  onRefresh: () => void;
}) {
  const account = useCurrentAccount();
  const rehypothecate = useRehypothecate();
  const recall = useRecall();
  const rates = useRates();
  const sponsoredExecute = useSponsoredExecute();

  // ---- live on-chain reads ----
  const [supplied, setSupplied] = useState(0);
  const [mark, setMarkState] = useState<number>(SPCX.initialMark);
  const [triggered, setTriggered] = useState(false);
  const [sigmaBps, setSigmaBps] = useState<number>(SPCX_VOL.seedSigmaBps);
  const [releaseProgress, setReleaseProgress] = useState(0);
  const [floorInfo, setFloorInfo] = useState<{ floor: number; deployable: number } | null>(null);

  // ---- simulated venue legs (Suilend / Navi) ----
  const [sims, setSims] = useState<SimVenues>({ suilend: null, navi: null, cashOut: 0 });

  // ---- live market + chart ----
  const [running, setRunning] = useState(false);
  const [autoCure, setAutoCure] = useState(true);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [chartEvents, setChartEvents] = useState<ChartEvent[]>([]);
  const stopRef = useRef(false);
  const pointsRef = useRef<ChartPoint[]>([]); // async loop's mirror (updaters stay pure)
  const marketRef = useRef<MarketSim | null>(null);
  const phaseRef = useRef<"idle" | "called">("idle"); // margin-call cycle state
  const wakeRef = useRef<(() => void) | null>(null); // inject() skips the cadence wait

  // ---- ux ----
  const [busy, setBusy] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow>(0);
  const [screenFlash, setScreenFlash] = useState<"crash" | "calm" | null>(null); // full-viewport mood wash
  const calmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashCrash = useCallback(() => {
    if (calmTimer.current) clearTimeout(calmTimer.current);
    setScreenFlash("crash");
  }, []);
  const flashCalm = useCallback(() => {
    if (calmTimer.current) clearTimeout(calmTimer.current);
    setScreenFlash("calm");
    calmTimer.current = setTimeout(() => setScreenFlash(null), 1900);
  }, []);
  const [bannerMsg, setBannerMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, number | "">>({});
  const [spikePrice, setSpikePrice] = useState<number>(SPCX.spikeMark);

  const aprs = {
    deepbook: rates?.rates.deepbook ?? 4.0,
    suilend: rates?.rates.suilend ?? 5.1,
    navi: rates?.rates.navi ?? 5.4,
  };

  const liquid = state?.liquid ?? 0;
  const rehyp = state?.rehypothecated ?? 0; // real DeepBook principal
  const reserved = state?.reserved ?? 0;
  const suilendVal = simValue(sims.suilend, aprs.suilend);
  const naviVal = simValue(sims.navi, aprs.navi);
  const simTotal = suilendVal + naviVal;
  const totalDeployed = rehyp + simTotal;
  // The sims hold `cashOut` of the real liquid (their COST BASIS, not their
  // live value): interest accrues inside the venue value without draining
  // liquid, and withdrawn interest lands back in liquid — every dollar of
  // uiLiquid + deployed reconciles to on-chain equity + unrealised interest.
  const uiLiquid = Math.max(0, liquid - sims.cashOut);
  // On-chain liquidity floor — $0 by default now (all locked IM is deployable),
  // so the client-side fallback (used only until the on-chain read lands) is $0
  // too. A desk's real on-chain value still wins whenever it has customised one.
  const floor = floorInfo?.floor ?? 0;
  const chainDeployable = floorInfo?.deployable ?? Math.max(0, liquid);
  // POLICY: only the LOCKED margin is rehypothecated. Free liquidity — the
  // VM/PnL buffer the institution reloads daily — never leaves the treasury
  // (routing all liquidity before the risk controls mature is a hack magnet).
  const imIdle = Math.max(0, reserved - totalDeployed); // locked IM not yet at a venue
  const deepbookMax = Math.floor(Math.max(0, Math.min(imIdle, chainDeployable)) * 100) / 100;
  const simMax = Math.floor(Math.max(0, Math.min(imIdle, uiLiquid - floor)) * 100) / 100;
  const pool = uiLiquid + totalDeployed;
  const pctDeployed = reserved > 0 ? Math.min(1, totalDeployed / reserved) : 0;
  const interest = Math.max(0, supplied - rehyp);
  // deployed above the current locked IM — legal on-chain (deploys predate the
  // IM-only policy, or contracts since closed released their IM) but out of
  // policy NOW; the UI must show it or "locked $20 / deployed $40" reads broken
  const overDeployed = Math.max(0, totalDeployed - reserved);

  // WHY each venue's deploy cap is what it is — rendered on the card itself so
  // a $0 max is never a silent contradiction of "IM is deployable"
  function capReason(venue: VenueKey): string {
    if (triggered) return `risk latch active — deploys freeze until release (auto-recalled otherwise)`;
    if (reserved <= 0) return "no locked IM yet — open a contract; only locked margin deploys";
    if (imIdle <= 0)
      return overDeployed > 0.005
        ? `all locked IM is out — incl. ${usd(overDeployed)} above policy (older deploys); Recall brings it home`
        : "all locked IM is deployed";
    const m = venue === "deepbook" ? deepbookMax : simMax;
    if (m <= 0)
      return `nothing liquid to deploy right now — recall a venue or load funds`;
    if (m < imIdle - 0.005)
      return `up to ${usd(m)} now — only that much of the ${usd(imIdle)} locked IM is currently liquid`;
    return `up to ${usd(m)} — locked IM not yet deployed`;
  }

  const pushPct = mark > 0 ? ((spikePrice - mark) / mark) * 100 : 0;
  const latchPct = Math.min((SPCX_VOL.zLatchX100 / 100) * (sigmaBps / 100), SPCX.triggerPct);
  const willTrigger = Math.abs(pushPct) >= latchPct;

  const poll = useCallback(async () => {
    try {
      const [sv, oc] = await Promise.all([readSuppliedValue(instId), oracleStatus()]);
      setSupplied(sv);
      setMarkState(oc.mark);
      setTriggered(oc.triggered);
      setSigmaBps(oc.sigmaBps);
      setReleaseProgress(oc.releaseProgress);
    } catch {
      /* transient */
    }
    try {
      setFloorInfo(await readFloor(instId));
    } catch {
      /* keep fallback */
    }
  }, [instId]);

  useEffect(() => {
    setSims(loadSimVenues(instId));
    poll();
    const t = setInterval(() => {
      if (!stopRef.current && !running) poll();
    }, 4000);
    return () => clearInterval(t);
  }, [poll, instId, running]);

  /** Shared per-print side-effects for market ticks AND manual pushes. */
  const applyTickResult = useCallback(
    async (r: OracleResult, wasTriggered: boolean, recalledRef: { deepbook: number; suilend: number; navi: number }) => {
      const point: ChartPoint = {
        price: r.mark,
        sigmaBps: r.sigmaBps,
        triggered: r.triggered,
        releaseProgress: r.releaseProgress,
      };
      pointsRef.current = [...pointsRef.current, point];
      const tickIndex = pointsRef.current.length - 1;
      setPoints(pointsRef.current);
      setMarkState(r.mark);
      setTriggered(r.triggered);
      setSigmaBps(r.sigmaBps);
      setReleaseProgress(r.releaseProgress);

      if (r.recalled) {
        // real DeepBook leg is back; pull the sim legs too (read store fresh)
        const fresh = loadSimVenues(instId);
        const suilendPre = simValue(fresh.suilend, aprs.suilend);
        const naviPre = simValue(fresh.navi, aprs.navi);
        const s = simWithdrawAll(instId, { suilend: aprs.suilend, navi: aprs.navi });
        setSims(s.all);
        recalledRef.deepbook = r.recalledAmount ?? 0;
        recalledRef.suilend = suilendPre;
        recalledRef.navi = naviPre;
        const total = recalledRef.deepbook + suilendPre + naviPre;
        flashCrash(); // collateral is pulling home NOW → red wash starts here
        setFlow(-1);
        if (r.recallDigest) setLastDigest(r.recallDigest);
        setChartEvents((es) => [...es, { tick: tickIndex, kind: "recall", amount: total }]);
        setBannerMsg({ tone: "red", text: `⚠ VOLATILITY TRIGGER · σ ${r.sigmaBps} bps · AUTO-DELEVERAGE · RECALLED ${usd(total)}` });
        onRefresh();
        setTimeout(() => setFlow(0), 900);
      }

      const released = wasTriggered && !r.triggered;
      if (released) {
        flashCalm(); // market calmed on its own → green wash → normal
        setFlow(1);
        // Redeposit is capped by what is deployable NOW, not by what was
        // recalled: VM paid during the crash shrinks the treasury (redepositing
        // the pre-crash principal aborts 23), and only locked margin redeploys.
        let deepbookBack = 0;
        let simBudget = 0;
        try {
          const [fresh, fl] = await Promise.all([readInstitution(instId), readFloor(instId)]);
          const imHeadroom = Math.max(0, fresh.reserved - fresh.rehypothecated);
          deepbookBack = Math.floor(Math.max(0, Math.min(recalledRef.deepbook, imHeadroom, fl.deployable)) * 100) / 100;
          simBudget = Math.max(0, imHeadroom - deepbookBack);
        } catch {
          /* reads failed — skip the redeposit rather than abort on-chain */
        }
        const suilendBack = Math.floor(Math.min(recalledRef.suilend, simBudget) * 100) / 100;
        const naviBack = Math.floor(Math.min(recalledRef.navi, Math.max(0, simBudget - suilendBack)) * 100) / 100;
        const back = deepbookBack + suilendBack + naviBack;
        setChartEvents((es) => [...es, { tick: tickIndex, kind: "redeposit", amount: back }]);
        setBannerMsg({
          tone: "green",
          text:
            back > 0
              ? `✓ VOLATILITY SUBSIDED ON-CHAIN (${SPCX_VOL.releaseNeeded} CALM PRINTS) · REDEPOSITING ${usd(back)}`
              : `✓ VOLATILITY SUBSIDED ON-CHAIN (${SPCX_VOL.releaseNeeded} CALM PRINTS) · nothing to redeposit — VM consumed the recalled margin`,
        });
        if (deepbookBack > 0) {
          try {
            const d = await rehypothecate(deepbookBack);
            setLastDigest(d);
          } catch (e) {
            setError(friendlyMoveError(e instanceof Error ? e.message : String(e)));
          }
        }
        if (suilendBack > 0) simDeposit(instId, "suilend", suilendBack, aprs.suilend);
        if (naviBack > 0) simDeposit(instId, "navi", naviBack, aprs.navi);
        setSims(loadSimVenues(instId));
        recalledRef.deepbook = 0;
        recalledRef.suilend = 0;
        recalledRef.navi = 0;
        onRefresh();
        setTimeout(() => setFlow(0), 900);
        setTimeout(() => setBannerMsg(null), 3500);
      }
      return released;
    },
    [instId, aprs.suilend, aprs.navi, rehypothecate, onRefresh, flashCrash, flashCalm],
  );

  /** Cure-step side effects: recall event + "positions survive" banner. */
  async function applyCure(cu: OracleResult, recalledRef: { deepbook: number; suilend: number; navi: number }) {
    const tickIndex = pointsRef.current.length - 1;
    if (cu.recalled) {
      const fresh = loadSimVenues(instId);
      const suilendPre = simValue(fresh.suilend, aprs.suilend);
      const naviPre = simValue(fresh.navi, aprs.navi);
      simWithdrawAll(instId, { suilend: aprs.suilend, navi: aprs.navi });
      setSims(loadSimVenues(instId));
      recalledRef.deepbook = cu.recalledAmount ?? 0;
      recalledRef.suilend = suilendPre;
      recalledRef.navi = naviPre;
      const total = recalledRef.deepbook + suilendPre + naviPre;
      flashCrash(); // collateral recalling home during the cure → red wash
      setFlow(-1);
      if (cu.recallDigest) setLastDigest(cu.recallDigest);
      setChartEvents((es) => [...es, { tick: tickIndex, kind: "recall", amount: total }]);
      setTimeout(() => setFlow(0), 900);
    }
    const survived = (cu.cured ?? []).filter((x) => x.status === 0 && x.deadline == null).length;
    setBannerMsg({
      tone: "green",
      text: `✓ PERMISSIONLESS RECALL → VM PAID FROM POOLED TREASURY · ${survived} position${survived === 1 ? "" : "s"} cured & survive`,
    });
    setTriggered(cu.triggered);
    setSigmaBps(cu.sigmaBps);
    onRefresh();
    setTimeout(() => setBannerMsg(null), 4000);
  }

  // ---- the live market loop ----
  async function toggleMarket() {
    if (running) {
      stopRef.current = true;
      return;
    }
    setError(null);
    setBannerMsg(null);
    marketRef.current = createMarketSim(mark);
    phaseRef.current = "idle";
    setRunning(true);
    stopRef.current = false;
    const recalledRef = { deepbook: 0, suilend: 0, navi: 0 };
    let wasTriggered = triggered;
    let misses = 0; // consecutive tick failures — transient errors must NOT kill the market
    try {
      while (!stopRef.current) {
        const t0 = Date.now();
        try {
          const price = marketRef.current.next();
          // arm the desk's contracts only while no call is pending, so the crash
          // tick cranks them (margin calls) instead of silently auto-recalling
          const arm = phaseRef.current === "idle" && otcIds.length ? otcIds : undefined;
          const r = await pushTick(instId, price, arm);
          // Draw the print only AFTER the tx confirms, so the price point lands
          // in the SAME frame as the recall/redeposit markers + treasury moves —
          // keeping the chart in lockstep with the on-chain collateral movements.
          const released = await applyTickResult(r, wasTriggered, recalledRef);
          wasTriggered = r.triggered;
          if (released) phaseRef.current = "idle"; // cycle complete — next crash can call again

          const calls = (r.marginCalls ?? []).filter((m) => m.deadline != null);
          if (calls.length && phaseRef.current === "idle") {
            phaseRef.current = "called";
            setBannerMsg({
              tone: "red",
              text: `⚠ MM BREACH → MARGIN CALL on ${calls.length} position${calls.length > 1 ? "s" : ""} · pooled funds are deployed · cure window running`,
            });
            onRefresh();
            await new Promise((res) => setTimeout(res, 2600));
            if (autoCure && !stopRef.current) {
              // a failed cure (e.g. the desk genuinely cannot cover) is a demo
              // STATE, not a reason to kill the market loop
              try {
                let cu = await cureCalls(instId, otcIds);
                await applyCure(cu, recalledRef);
                wasTriggered = cu.triggered;
                let uncured = (cu.cured ?? []).filter((x) => x.status === 0 && x.deadline != null).length > 0
                  || (cu.cured ?? []).length === 0;
                if (uncured && adminCapId && account) {
                  // recall alone moves funds home — it can't ADD capital. The
                  // margin call is a CAPITAL CALL: wire the daily reload.
                  setBannerMsg({
                    tone: "red",
                    text: `⚠ CAPITAL CALL — recall alone can't cover the VM · wiring the daily treasury reload (+${usd(RELOAD_USD)}, mock on-ramp)…`,
                  });
                  await reloadTreasury(RELOAD_USD);
                  cu = await cureCalls(instId, otcIds);
                  await applyCure(cu, recalledRef);
                  wasTriggered = cu.triggered;
                  uncured = (cu.cured ?? []).filter((x) => x.status === 0 && x.deadline != null).length > 0
                    || (cu.cured ?? []).length === 0;
                  if (!uncured) {
                    setBannerMsg({
                      tone: "green",
                      text: `✓ CURED — recall brought the IM home + the ${usd(RELOAD_USD)} reload covered the VM · positions pay & survive`,
                    });
                  }
                }
                if (uncured) {
                  setBannerMsg({
                    tone: "red",
                    text: "⚠ CURE INSUFFICIENT — even after the recall + reload the desk cannot cover · it liquidates when the countdown lapses",
                  });
                }
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setBannerMsg({ tone: "red", text: `⚠ CURE FAILED — ${friendlyMoveError(msg)}` });
              }
            }
          }
          misses = 0;
        } catch (e) {
          // transient RPC/route hiccup: warn and keep ticking; stop only when persistent
          misses += 1;
          const msg = e instanceof Error ? e.message : String(e);
          if (misses >= 3) {
            setError(`Market stopped after repeated failures: ${friendlyMoveError(msg)}`);
            break;
          }
          setBannerMsg({ tone: "red", text: `⚠ transient tick error (${misses}/3, retrying) — ${friendlyMoveError(msg).slice(0, 90)}` });
        }
        // cadence wait is interruptible: an injected event wakes the loop so the
        // crash/spike print goes out as soon as the in-flight tx is done
        const wait = CADENCE_MS - (Date.now() - t0);
        if (wait > 0) {
          await new Promise<void>((res) => {
            wakeRef.current = res;
            setTimeout(res, wait);
          });
          wakeRef.current = null;
        }
      }
    } finally {
      setRunning(false);
      stopRef.current = false;
    }
  }

  function inject(kind: MarketEventKind) {
    marketRef.current?.inject(kind);
    wakeRef.current?.(); // fire the next print now, don't wait out the cadence
    if (kind === "calm") {
      flashCalm(); // green wash → back to normal
      return;
    }
    // NOTE: the red screen wash is NOT fired here (while the crash is "brewing")
    // — it starts at the actual recall moment (see applyTickResult/applyCure),
    // so the screen goes red exactly as the collateral pulls home.
    {
      const text =
        kind === "crash"
          ? "💥 CRASH BREWING — tremors first: watch the trigger pull collateral home BEFORE the main leg"
          : "▲ SQUEEZE BREWING — tremors first: the trigger pulls collateral home BEFORE the main leg up";
      setBannerMsg({ tone: "red", text });
      setTimeout(() => setBannerMsg(null), 2600);
    }
  }

  async function doReset() {
    setError(null);
    setBusy("reset");
    stopRef.current = true;
    try {
      // pass the open contracts: reset also defuses STALE margin calls on them
      // (a pending call survives an oracle reset and would instant-liquidate the
      // next breach — either side's — against its long-expired cure window)
      const r = await resetOracle(otcIds);
      setMarkState(r.mark);
      setTriggered(r.triggered);
      setSigmaBps(r.sigmaBps);
      setReleaseProgress(0);
      pointsRef.current = [];
      setPoints([]);
      setChartEvents([]);
      setBannerMsg(null);
      if (calmTimer.current) clearTimeout(calmTimer.current);
      setScreenFlash(null); // clean stage — clear any mood wash
      phaseRef.current = "idle";
      if (r.clearedCalls?.length) {
        setBannerMsg({ tone: "green", text: `✓ STAGE RESET · ${r.clearedCalls.length} stale margin call${r.clearedCalls.length > 1 ? "s" : ""} defused (fresh cure window on the next breach)` });
        setTimeout(() => setBannerMsg(null), 3500);
      }
      if (r.stillCalled?.length) {
        setError(
          `${r.stillCalled.length} position${r.stillCalled.length > 1 ? "s are" : " is"} still breached with a live margin call — cure (deposit / recall) before the next crank, or it liquidates.`,
        );
      }
      await poll();
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // manual push — same machinery, one print at a time
  const manualRecalledRef = useRef({ deepbook: 0, suilend: 0, navi: 0 });
  async function doPush() {
    if (!Number.isFinite(spikePrice) || spikePrice <= 0) return;
    setError(null);
    setBusy("push");
    try {
      const wasTriggered = triggered;
      const r = willTrigger && !triggered ? await triggerAndRecall(instId, spikePrice) : await pushTick(instId, spikePrice);
      await applyTickResult(r, wasTriggered, manualRecalledRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBannerMsg(null);
    } finally {
      setBusy(null);
    }
  }

  /* The CAPITAL-CALL cure leg: a margin call means available capital (equity −
     locked IM) can't cover the VM — and a recall can never fix that (it moves
     funds home, it doesn't add any; a desk's own locked IM can't pay its own
     VM). The cure that works is the institution's daily treasury reload —
     here the mock on-ramp mints it and the desk deposits, gasless. */
  const RELOAD_USD = 20;
  async function reloadTreasury(amount: number) {
    if (!account || !adminCapId) throw new Error("no admin session for the treasury reload");
    const r = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: account.address, amount }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.coinId) throw new Error(d.error ?? "on-ramp failed");
    const digest = await sponsoredExecute((tx) => {
      tx.moveCall({
        target: TARGET.institution.deposit,
        typeArguments: [DBUSDC_TYPE],
        arguments: [tx.object(instId), tx.object(adminCapId), tx.object(d.coinId)],
      });
    });
    await suiRead.waitForTransaction({ digest });
  }

  // ---- per-venue deploy / recall (DeepBook real; Suilend/Navi sim) ----
  async function venueDeploy(venue: VenueKey) {
    // While the risk trigger is LATCHED, any tick auto-recalls all venues —
    // a deploy would silently vanish on the next print ("my rehypothecation
    // disappeared"). Refuse with the reason instead.
    if (triggered) {
      return setError(
        `Risk trigger is LATCHED — deploys are auto-recalled by the next tick. Wait for the release (${releaseProgress}/${SPCX_VOL.releaseNeeded} calm prints) or press Reset.`,
      );
    }
    const max = venue === "deepbook" ? deepbookMax : simMax;
    const amt = Math.min(Number(amounts[venue]) || max, max);
    if (!state) return setError("Treasury state is still loading — try again in a second.");
    if (amt <= 0) return setError(`Deploy unavailable: ${capReason(venue)}`);
    setError(null);
    setBusy(`d-${venue}`);
    setFlow(1);
    try {
      if (venue === "deepbook") {
        const digest = await rehypothecate(Math.floor(amt * 100) / 100);
        setLastDigest(digest);
        onRefresh();
        await poll();
      } else {
        setSims(simDeposit(instId, venue, amt, aprs[venue]));
      }
      setAmounts((a) => ({ ...a, [venue]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setTimeout(() => setFlow(0), 600);
    }
  }

  async function venueRecall(venue: VenueKey) {
    const inVenue = venue === "deepbook" ? rehyp : venue === "suilend" ? suilendVal : naviVal;
    const amt = Math.min(Number(amounts[venue]) || inVenue, inVenue);
    if (!state) return setError("Treasury state is still loading — try again in a second.");
    if (amt <= 0) return setError(`Nothing to recall from ${venue} — its balance is ${usd(inVenue)}.`);
    setError(null);
    setBusy(`r-${venue}`);
    setFlow(-1);
    try {
      if (venue === "deepbook") {
        const digest = await recall(Math.floor(amt * 100) / 100);
        setLastDigest(digest);
        onRefresh();
        await poll();
      } else {
        setSims(simWithdraw(instId, venue, amt, aprs[venue]).all);
      }
      setAmounts((a) => ({ ...a, [venue]: "" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setTimeout(() => setFlow(0), 600);
    }
  }

  /** Move collateral venue → venue without touching the treasury total:
   *  recall/withdraw out of the source, deploy into the target. DeepBook legs
   *  are real testnet txs; SIM legs settle instantly in the ledger. */
  const windowPoints = points.slice(-WINDOW);
  const startTick = points.length - windowPoints.length;

  return (
    <>
      {/* dramatic full-viewport mood wash: pulsing red while a crash unfolds,
          a green fade when the market calms (click-through) */}
      {screenFlash && (
        <div
          className={`pointer-events-none fixed inset-0 z-40 ${screenFlash === "crash" ? "fm-crash-wash" : "fm-calm-wash"}`}
          aria-hidden
        />
      )}
      <section className="relative mt-6 overflow-hidden rounded-[16px] border border-line-strong bg-surface">
      {bannerMsg && (
        <div
          className="fm-banner-in absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 py-2.5 text-[13px] font-semibold tracking-[0.06em] text-bg"
          style={{ background: bannerMsg.tone === "green" ? STATUS.green : STATUS.red }}
        >
          {bannerMsg.text}
        </div>
      )}

      {/* SPCX strip: mark + σ + latch state */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-4"
        style={triggered ? { background: "rgba(180,52,31,0.07)" } : undefined}
      >
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-soft">
            Collateral manager
          </span>
          <span className="text-[12px] text-muted">risk-responsive rehypothecation</span>
        </div>
        <div className="flex items-center gap-5">
          <span className="font-mono text-[12px] text-muted">
            EWMA σ <span className="font-semibold" style={{ color: "#7a5cd6" }}>{sigmaBps} bps</span>
          </span>
          {triggered && (
            <span className="font-mono text-[12px] font-semibold" style={{ color: STATUS.red }}>
              LATCHED · release {releaseProgress}/{SPCX_VOL.releaseNeeded}
            </span>
          )}
          <div className="text-right">
            <div className="flex items-center justify-end gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{SPCX.symbol}</span>
              <span className={`fm-pulse h-[6px] w-[6px] rounded-full`} style={{ background: triggered ? STATUS.red : STATUS.green }} />
            </div>
            <div className="font-mono text-[22px] font-semibold text-ink">{usd(mark)}</div>
          </div>
        </div>
      </div>

      {/* live market controls + chart */}
      <div className="border-b border-line px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={toggleMarket}
              disabled={!!busy}
              className={`rounded-[7px] border px-4 py-2 text-[13px] font-semibold transition-colors disabled:opacity-40 ${
                running ? "border-line-strong text-ink hover:bg-bg" : "border-line-strong bg-ink text-bg hover:opacity-90"
              }`}
            >
              {running ? "■ Stop market" : "▶ Start live market"}
            </button>
            <button
              onClick={() => inject("crash")}
              disabled={!running}
              title="Pre-empted crash: −3…5% tremors latch the trigger and recall collateral BEFORE the −12…13% main gap lands"
              className="rounded-[7px] border px-3.5 py-2 text-[13px] font-semibold transition-colors disabled:opacity-30"
              style={{ borderColor: STATUS.red, color: STATUS.red }}
            >
              💥 Crash
            </button>
            <button
              onClick={() => inject("spike")}
              disabled={!running}
              title="Gradual squeeze UP: +3…5% tremors latch the trigger and recall collateral BEFORE the +12…13% main leg (cumulative +19…21%)"
              className="rounded-[7px] border border-line-strong px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-bg disabled:opacity-30"
            >
              ▲ Spike
            </button>
            <button
              onClick={() => inject("calm")}
              disabled={!running}
              className="rounded-[7px] border border-line-strong px-3.5 py-2 text-[13px] font-semibold transition-colors hover:bg-bg disabled:opacity-30"
              style={{ color: STATUS.green }}
            >
              ≈ Calm
            </button>
            <button
              onClick={doReset}
              disabled={!!busy || running}
              className="rounded-[7px] border border-line-strong px-3.5 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-bg disabled:opacity-40"
            >
              {busy === "reset" ? "…" : "Reset"}
            </button>
            {otcIds.length > 0 && (
              <label className="ml-1 flex cursor-pointer items-center gap-1.5 text-[11px] text-muted" title="On a margin call: permissionless recall + the daily treasury reload (+$20 mock on-ramp) + re-crank — positions pay and survive. Untick to let the cure window run out (liquidation drill).">
                <input type="checkbox" checked={autoCure} onChange={(e) => setAutoCure(e.target.checked)} className="accent-[#0f0f0f]" />
                auto-cure margin calls
              </label>
            )}
          </div>
        </div>
        {windowPoints.length > 0 ? (
          <ScenarioChart points={windowPoints} events={chartEvents} startTick={startTick} minSlots={Math.min(WINDOW, Math.max(24, windowPoints.length))} />
        ) : (
          <div className="flex h-[120px] items-center justify-center rounded-[10px] border border-dashed border-line-strong">
            <p className="px-4 text-center font-mono text-[12px] text-muted">
              ▶ Start the live market — the price feed and the EWMA σ signal stream here; then hit 💥 Crash and watch the recall fire.
            </p>
          </div>
        )}
      </div>

      {/* flow: liquid treasury — conduit — deployed across venues */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-0 px-6 py-6">
        <Vessel
          label="Locked IM · margin backing open contracts"
          big={usd(reserved)}
          sub={
            reserved > 0
              ? `${usd(imIdle)} still in treasury · ${usd(Math.min(totalDeployed, reserved))} at venues · free liquidity ${usd(Math.max(0, uiLiquid - imIdle))} never deploys`
              : `no contracts yet · free liquidity ${usd(uiLiquid)} never deploys`
          }
          pct={reserved > 0 ? imIdle / reserved : 0}
          tone="ink"
        />
        <Conduit flow={flow} />
        <Vessel
          label="Deployed to venues · earning"
          big={usd(totalDeployed)}
          sub={
            overDeployed > 0.005
              ? `⚠ ${usd(overDeployed)} above the current locked IM (older deploys) — Recall brings it home`
              : interest > 0
                ? `+${usd(interest, { maximumFractionDigits: 4 })} accrued on DeepBook`
                : totalDeployed > 0
                  ? "locked IM earning across venues"
                  : imIdle > 0
                    ? `locked IM ${usd(imIdle)} ready to deploy`
                    : "— no margin locked —"
          }
          pct={pctDeployed}
          tone="green"
          subGreen={totalDeployed > 0 && overDeployed <= 0.005}
        />
      </div>

      {/* capital allocation strip — where every dollar sits, at a glance */}
      <AllocationStrip
        liquid={uiLiquid}
        imIdle={imIdle}
        floor={floor}
        flow={flow}
        pctDeployed={pctDeployed}
        overDeployed={overDeployed}
        legs={[
          { key: "deepbook", name: "DeepBook", value: rehyp },
          { key: "suilend", name: "Suilend", value: suilendVal },
          { key: "navi", name: "Navi", value: naviVal },
        ]}
      />

      {/* per-venue cards */}
      <div className="grid gap-3 px-6 pb-6 sm:grid-cols-3">
        <VenueCard venue="deepbook" name="DeepBook margin" logo="/logos/deepbook.png" badge="real · testnet" value={rehyp} share={totalDeployed > 0 ? rehyp / totalDeployed : 0} apr={aprs.deepbook} max={deepbookMax} reason={capReason("deepbook")} accrued={interest} amounts={amounts} setAmounts={setAmounts} busy={busy} onDeploy={() => venueDeploy("deepbook")} onRecall={() => venueRecall("deepbook")} />
        <VenueCard venue="suilend" name="Suilend" logo="/logos/suilend.png" badge="sim · live mainnet APR" value={suilendVal} share={totalDeployed > 0 ? suilendVal / totalDeployed : 0} apr={aprs.suilend} max={simMax} reason={capReason("suilend")} accrued={simAccrued(sims.suilend, aprs.suilend)} amounts={amounts} setAmounts={setAmounts} busy={busy} onDeploy={() => venueDeploy("suilend")} onRecall={() => venueRecall("suilend")} />
        <VenueCard venue="navi" name="Navi" logo="/logos/navi.png" badge="sim · live mainnet APR" value={naviVal} share={totalDeployed > 0 ? naviVal / totalDeployed : 0} apr={aprs.navi} max={simMax} reason={capReason("navi")} accrued={simAccrued(sims.navi, aprs.navi)} amounts={amounts} setAmounts={setAmounts} busy={busy} onDeploy={() => venueDeploy("navi")} onRecall={() => venueRecall("navi")} />
      </div>

      {/* provenance */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-6 py-3 font-mono text-[11px] text-muted">
        <span style={{ color: STATUS.green }}>● DeepBook leg real on testnet</span>
        <span>● Suilend/Navi legs simulated · PTBs validated on mainnet</span>
        {lastDigest && (
          <a href={explorer.tx(lastDigest)} target="_blank" rel="noreferrer" className="underline hover:text-ink">
            tx {lastDigest.slice(0, 10)}… ↗
          </a>
        )}
        <a href={explorer.object(DEEPBOOK.dbusdcMarginPool)} target="_blank" rel="noreferrer" className="underline hover:text-ink">
          DeepBook pool {DEEPBOOK.dbusdcMarginPool.slice(0, 8)}… ↗
        </a>
      </div>

      {/* manual oracle controls (backup mode) */}
      <div className="space-y-2 border-t border-line bg-bg px-6 py-4">
        <div className="flex items-end gap-2">
          <NumField label={`Push SPCX mark manually · now ${usd(mark)}`} value={spikePrice} onChange={(v) => setSpikePrice(+v || 0)} />
          <button
            onClick={doPush}
            disabled={!!busy || running}
            className={`rounded-[7px] border px-4 py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40 ${willTrigger ? "hover:text-bg" : "border-line-strong text-ink hover:bg-surface"}`}
            style={willTrigger ? { borderColor: STATUS.red, color: STATUS.red } : undefined}
          >
            {busy === "push" ? "…" : "Push print →"}
          </button>
        </div>
        <p className="font-mono text-[11px] leading-[1.5]">
          <span className={willTrigger ? "font-semibold" : "text-muted"} style={willTrigger ? { color: STATUS.red } : undefined}>
            Δ {pushPct >= 0 ? "+" : ""}{pushPct.toFixed(1)}% vs {usd(mark)}
          </span>
          <span className="text-muted"> · latches beyond ±{latchPct.toFixed(1)}% (z &gt; {(SPCX_VOL.zLatchX100 / 100).toFixed(0)}σ at current σ) · </span>
          {willTrigger ? (
            <span style={{ color: STATUS.red }}>would latch → permissionless recall</span>
          ) : (
            <span className="text-muted">in band{triggered ? ` → counts toward on-chain release (${releaseProgress}/${SPCX_VOL.releaseNeeded})` : ""}</span>
          )}
        </p>
      </div>

      {error && <p className="break-words px-6 pb-4 text-[12px]" style={{ color: STATUS.red }}>{error}</p>}
      </section>
    </>
  );
}

/** One stacked bar = the whole desk: free liquidity (VM/PnL buffer — never
 *  leaves the treasury), locked IM awaiting deploy, then each venue's deployed
 *  IM in its accent, with the on-chain liquidity floor as an inline marker.
 *  Encodes the policy: ONLY locked margin is rehypothecated. */
function AllocationStrip({
  liquid,
  imIdle,
  floor,
  flow,
  pctDeployed,
  overDeployed,
  legs,
}: {
  liquid: number; // UI-liquid (free + locked-idle)
  imIdle: number; // locked IM not yet deployed (part of `liquid`)
  floor: number;
  flow: Flow;
  pctDeployed: number;
  overDeployed: number; // deployed above the current locked IM (older deploys)
  legs: { key: VenueKey; name: string; value: number }[];
}) {
  const fenced = Math.min(imIdle, liquid);
  const free = Math.max(0, liquid - fenced);
  const pool = liquid + legs.reduce((s, l) => s + l.value, 0);
  const pct = (v: number) => (pool > 0 ? (v / pool) * 100 : 0);
  const floorPct = Math.min(100, pct(Math.min(floor, pool)));
  return (
    <div className="px-6 pb-5">
      <div className="mb-1.5 flex items-baseline justify-between font-mono text-[11px] tracking-[0.1em] text-muted">
        <span className="uppercase">Capital allocation · only locked margin deploys</span>
        <span>{Math.round(pctDeployed * 100)}% of locked margin earning</span>
      </div>
      <div className="relative flex h-[22px] w-full gap-[2px] overflow-hidden rounded-[7px]">
        <div
          className="h-full min-w-[2px] rounded-l-[7px] transition-[width] duration-700 ease-out"
          style={{ width: `${pct(free)}%`, background: "rgba(0,0,0,0.06)", border: "1px solid var(--color-line)" }}
          title={`free liquidity ${usd(free)} — VM/PnL buffer, never deployed`}
        />
        {fenced > 0 && (
          <div
            className="h-full transition-[width] duration-700 ease-out"
            style={{ width: `${pct(fenced)}%`, background: "rgba(0,0,0,0.20)" }}
            title={`locked IM ${usd(fenced)} — margin held for open contracts, awaiting deploy`}
          />
        )}
        {legs.map(
          (l) =>
            l.value > 0 && (
              <div
                key={l.key}
                className="h-full transition-[width] duration-700 ease-out last:rounded-r-[7px]"
                style={{ width: `${pct(l.value)}%`, background: VENUE_ACCENT[l.key], opacity: flow === -1 ? 0.55 : 1 }}
                title={`${l.name} ${usd(l.value)}`}
              />
            ),
        )}
        {/* on-chain liquidity floor marker (deploys below it abort) */}
        {floor > 0 && pool > 0 && (
          <div className="pointer-events-none absolute inset-y-0" style={{ left: `${floorPct}%` }}>
            <div className="h-full w-[2px]" style={{ background: STATUS.red, opacity: 0.7 }} />
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className="h-[8px] w-[8px] rounded-[2px]" style={{ background: "rgba(0,0,0,0.10)", border: "1px solid var(--color-line-strong)" }} />
          free liquidity {usd(free)} <span className="text-faint">· VM/PnL stays here</span>
        </span>
        <span className="flex items-center gap-1.5" style={{ opacity: fenced > 0 ? 1 : 0.45 }} title="margin locked to open contracts, still in the treasury — the only capital that deploys">
          <span className="h-[8px] w-[8px] rounded-[2px]" style={{ background: "rgba(0,0,0,0.28)" }} />
          locked IM {usd(fenced)} <span className="text-faint">· undeployed</span>
        </span>
        {overDeployed > 0.005 && (
          <span className="flex items-center gap-1 font-semibold" style={{ color: "#8a6d1a" }} title="deployed before the IM-only policy (or the contracts since released their IM) — Recall brings it back to the treasury">
            ⚠ {usd(overDeployed)} deployed above locked IM
          </span>
        )}
        {legs.map((l) => (
          <span key={l.key} className="flex items-center gap-1.5" style={{ opacity: l.value > 0 ? 1 : 0.45 }}>
            <span className="h-[8px] w-[8px] rounded-[2px]" style={{ background: VENUE_ACCENT[l.key] }} />
            {l.name} {usd(l.value)}
            {pool > 0 && l.value > 0 && <span className="text-faint">({Math.round(pct(l.value))}%)</span>}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          <span className="h-[10px] w-[2px]" style={{ background: STATUS.red, opacity: 0.7 }} />
          floor {usd(floor)} <span className="text-faint">· deploys below abort on-chain</span>
        </span>
      </div>
    </div>
  );
}

function VenueCard({
  venue,
  name,
  logo,
  badge,
  value,
  share,
  apr,
  max,
  reason,
  accrued,
  amounts,
  setAmounts,
  busy,
  onDeploy,
  onRecall,
}: {
  venue: VenueKey;
  name: string;
  logo: string;
  badge: string;
  value: number;
  share: number; // of total deployed
  apr: number;
  max: number; // deployable into this venue right now
  reason: string; // WHY max is what it is — always visible, never a silent $0
  accrued?: number; // realised interest above principal (DeepBook: live on-chain)
  amounts: Record<string, number | "">;
  setAmounts: React.Dispatch<React.SetStateAction<Record<string, number | "">>>;
  busy: string | null;
  onDeploy: () => void;
  onRecall: () => void;
}) {
  const accent = VENUE_ACCENT[venue];
  const real = venue === "deepbook";
  const capacity = value + Math.max(0, max); // deployed + headroom available now
  const fillPct = capacity > 0 ? (value / capacity) * 100 : 0;
  const perYear = (value * apr) / 100;
  return (
    <div className="rounded-[12px] border border-line-strong bg-bg p-4" style={{ borderTop: `3px solid ${accent}` }}>
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Image src={logo} alt="" width={22} height={22} className="rounded-[5px]" />
          <span className="text-[13.5px] font-semibold text-ink">{name}</span>
        </span>
        <span
          className="rounded-[4px] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em]"
          style={real ? { background: "rgba(31,111,77,0.12)", color: "#1a6042" } : { background: "rgba(0,0,0,0.06)", color: "var(--color-muted)" }}
        >
          {badge}
        </span>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="font-mono text-[22px] font-semibold" style={{ color: value > 0 ? accent : "var(--color-ink)" }}>
          {usd(value)}
        </span>
        <span className="text-right">
          <span className="block font-mono text-[12px] font-semibold" style={{ color: "#1a6042" }}>
            {apr.toFixed(2)}% APR
          </span>
          <span className="block font-mono text-[10.5px] text-muted">
            {value > 0 ? `≈ ${usd(perYear)}/yr` : "deploy to earn"}
          </span>
        </span>
      </div>
      {/* deployed vs headroom-now — how "full" this venue is for the desk */}
      <div className="mt-2.5 h-[7px] w-full overflow-hidden rounded-full bg-[rgba(0,0,0,0.07)]">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${fillPct}%`, background: accent }} />
      </div>
      <div className="mt-1 flex items-center justify-between font-mono text-[10.5px] text-muted">
        <span>{value > 0 ? `${Math.round(share * 100)}% of deployed` : "idle"}</span>
        <span>
          {accrued && accrued > 0
            ? <span style={{ color: "#1a6042" }}>+{usd(accrued, { maximumFractionDigits: 4 })} accrued</span>
            : max > 0
              ? `headroom ${usd(max)}`
              : "no headroom"}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <input
          type="number"
          placeholder={max > 0 ? `max ${Math.floor(max * 100) / 100}` : "—"}
          value={amounts[venue] ?? ""}
          onChange={(e) => {
            const v = e.target.value === "" ? "" : +e.target.value;
            setAmounts((a) => ({ ...a, [venue]: v }));
          }}
          className="w-full min-w-0 rounded-[6px] border border-line px-2 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-line-strong"
        />
        <button
          onClick={onDeploy}
          disabled={!!busy}
          className="shrink-0 rounded-[6px] px-2.5 py-1.5 text-[11.5px] font-semibold text-white hover:opacity-90 disabled:opacity-40"
          style={{ background: accent }}
        >
          {busy === `d-${venue}` ? "…" : "Deploy"}
        </button>
        <button
          onClick={onRecall}
          disabled={!!busy || value <= 0}
          className="shrink-0 rounded-[6px] border border-line-strong px-2.5 py-1.5 text-[11.5px] font-semibold text-ink hover:bg-surface disabled:opacity-40"
        >
          {busy === `r-${venue}` ? "…" : "Recall"}
        </button>
      </div>
      {/* why the cap is what it is — a $0 max must explain itself */}
      <p className="mt-1.5 text-[10.5px] leading-[1.5]" style={{ color: max > 0 ? "var(--color-faint, #a09a8e)" : "#8a6d1a" }}>
        {reason}
      </p>
    </div>
  );
}

function Vessel({
  label,
  big,
  sub,
  pct,
  tone,
  subGreen,
}: {
  label: string;
  big: string;
  sub: string;
  pct: number;
  tone: "ink" | "green";
  subGreen?: boolean;
}) {
  const edge = tone === "green" ? STATUS.green : "#2456c4";
  const fill = tone === "green" ? "rgba(31,111,77,0.12)" : "rgba(36,86,196,0.10)";
  return (
    <div className="relative flex min-h-[130px] flex-col justify-between overflow-hidden rounded-[12px] border border-line-strong bg-bg p-5">
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 transition-[height] duration-700 ease-out"
        style={{ height: `${Math.min(1, pct) * 100}%`, background: fill, borderTop: `2px solid ${edge}` }}
      />
      <div className="relative">
        <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.13em] text-muted">{label}</p>
      </div>
      <div className="relative">
        <p className="font-mono text-[24px] font-semibold text-ink">{big}</p>
        <p className="font-mono text-[12px]" style={{ color: subGreen ? STATUS.green : "var(--color-muted)" }}>{sub}</p>
      </div>
    </div>
  );
}

function Conduit({ flow }: { flow: Flow }) {
  const cls = flow === 1 ? "fm-flow-right" : flow === -1 ? "fm-flow-left" : "";
  const color = flow === -1 ? FLOW.recall : flow === 1 ? FLOW.deploy : "var(--color-line-strong)";
  const caption = flow === 1 ? "DEPLOYING →" : flow === -1 ? "◄ RECALLING" : "IDLE";
  return (
    <div className="flex w-[120px] flex-col items-center justify-center gap-1 px-2">
      <svg width="120" height="34" viewBox="0 0 120 34" aria-hidden>
        <line x1="4" y1="17" x2="116" y2="17" stroke="var(--color-line-strong)" strokeWidth="1.5" opacity="0.6" />
        {flow !== 0 && (
          <line
            x1="4" y1="17" x2="116" y2="17"
            stroke={color} strokeWidth="4.5" strokeDasharray="9 8" strokeLinecap="round"
            className={cls}
            style={{ filter: `drop-shadow(0 0 5px ${color})` }}
          />
        )}
      </svg>
      <span
        className="font-mono text-[11px] font-bold tracking-[0.1em]"
        style={{ color: flow === 0 ? "var(--color-muted)" : color, textShadow: flow !== 0 ? `0 0 8px ${color}66` : "none" }}
      >
        {caption}
      </span>
    </div>
  );
}

function NumField({ label, value, onChange }: { label: string; value: number; onChange: (v: string) => void }) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted">{label}</span>
      <div className="flex items-center rounded-[7px] border border-line-strong bg-surface px-2.5">
        <span className="text-[14px] text-muted">$</span>
        <input
          type="number"
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent px-1 py-2 font-mono text-[14px] font-semibold text-ink outline-none"
        />
      </div>
    </label>
  );
}
