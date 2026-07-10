"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { DEEPBOOK, SPCX, SPCX_VOL, explorer, usd } from "@/lib/fullmetal";
import type { InstState } from "@/lib/institution-state";
import { readFloor, readSuppliedValue } from "@/lib/institution-state";
import { cureCalls, oracleStatus, pushTick, resetOracle, triggerAndRecall, type OracleResult } from "@/lib/oracle";
import { useRates } from "@/lib/rates";
import { useRecall, useRehypothecate } from "@/lib/rehypo-actions";
import { SCENARIOS, type Scenario, type ScenarioKey } from "@/lib/scenario";
import { loadSimVenues, simDeposit, simValue, simWithdraw, simWithdrawAll, type SimVenues } from "@/lib/venues";
import ScenarioChart, { type ChartEvent, type ChartPoint } from "./ScenarioChart";

type Flow = -1 | 0 | 1;

export default function RehypoHero({
  instId,
  state,
  otcIds = [],
  onRefresh,
}: {
  instId: string;
  state: InstState | null;
  /** the desk's open contracts — armed into the crash ticks so the breach
   *  crank fires while liquidity is out (margin call → cure → survive) */
  otcIds?: string[];
  onRefresh: () => void;
}) {
  const rehypothecate = useRehypothecate();
  const recall = useRecall();
  const rates = useRates();

  // ---- live on-chain reads ----
  const [supplied, setSupplied] = useState(0); // DeepBook position incl. interest
  const [mark, setMarkState] = useState<number>(SPCX.initialMark);
  const [triggered, setTriggered] = useState(false);
  const [sigmaBps, setSigmaBps] = useState<number>(SPCX_VOL.seedSigmaBps);
  const [releaseProgress, setReleaseProgress] = useState(0);
  const [floorInfo, setFloorInfo] = useState({ floor: 0, deployable: 0 });

  // ---- simulated venue legs (Suilend / Navi) ----
  const [sims, setSims] = useState<SimVenues>({ suilend: null, navi: null });

  // ---- scenario player + chart ----
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>("flash-crash");
  const [autoCure, setAutoCure] = useState(true);
  const [running, setRunning] = useState(false);
  const [points, setPoints] = useState<ChartPoint[]>([]);
  const [chartEvents, setChartEvents] = useState<ChartEvent[]>([]);
  const [frameTicks, setFrameTicks] = useState(0);
  const stopRef = useRef(false);
  // mirror of `points` for the async tick loop (setState updaters must stay pure)
  const pointsRef = useRef<ChartPoint[]>([]);

  // ---- ux ----
  const [busy, setBusy] = useState<string | null>(null);
  const [flow, setFlow] = useState<Flow>(0);
  const [bannerMsg, setBannerMsg] = useState<{ tone: "red" | "green"; text: string } | null>(null);
  const [lastDigest, setLastDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [amounts, setAmounts] = useState<Record<string, number | "">>({});
  const [spikePrice, setSpikePrice] = useState<number>(SPCX.spikeMark);

  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) ?? SCENARIOS[0];

  const aprs = {
    deepbook: rates?.rates.deepbook ?? 4.0,
    suilend: rates?.rates.suilend ?? 5.1,
    navi: rates?.rates.navi ?? 5.4,
  };

  const liquid = state?.liquid ?? 0;
  const rehyp = state?.rehypothecated ?? 0; // real DeepBook principal
  const reserved = state?.reserved ?? 0; // posted IM across contracts
  const suilendVal = simValue(sims.suilend, aprs.suilend);
  const naviVal = simValue(sims.navi, aprs.navi);
  const simTotal = suilendVal + naviVal;
  const totalDeployed = rehyp + simTotal;
  // Deployable = whatever liquid treasury sits above the ON-CHAIN liquidity
  // floor (max(stress, 25% of reserved IM) — the deploy tx aborts below it).
  // Sim legs draw from the same UI budget so the picture stays coherent.
  const uiLiquid = Math.max(0, liquid - simTotal);
  const floor = floorInfo.floor;
  const deployable = Math.max(0, Math.floor(Math.max(0, floorInfo.deployable - simTotal) * 100) / 100);
  const pool = uiLiquid + totalDeployed;
  const pctDeployed = pool > 0 ? Math.min(1, totalDeployed / pool) : 0;
  const interest = Math.max(0, supplied - rehyp);

  const pushPct = mark > 0 ? ((spikePrice - mark) / mark) * 100 : 0;
  // live latch threshold: min(4σ z-latch, legacy 15% jump)
  const latchPct = Math.min((SPCX_VOL.zLatchX100 / 100) * (sigmaBps / 100), SPCX.triggerPct);
  const willTrigger = Math.abs(pushPct) >= latchPct;

  const poll = useCallback(async () => {
    try {
      const [sv, oc, fl] = await Promise.all([readSuppliedValue(instId), oracleStatus(), readFloor(instId)]);
      setSupplied(sv);
      setMarkState(oc.mark);
      setTriggered(oc.triggered);
      setSigmaBps(oc.sigmaBps);
      setReleaseProgress(oc.releaseProgress);
      setFloorInfo(fl);
    } catch {
      /* transient */
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

  /** Shared recall/release side-effects for scenario ticks AND manual pushes. */
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
        // real DeepBook leg is back in the treasury; pull the sim legs too.
        // Read sim values fresh from the store (React state may be stale here).
        const fresh = loadSimVenues(instId);
        const suilendPre = simValue(fresh.suilend, aprs.suilend);
        const naviPre = simValue(fresh.navi, aprs.navi);
        const s = simWithdrawAll(instId, { suilend: aprs.suilend, navi: aprs.navi });
        setSims(s.all);
        recalledRef.deepbook = r.recalledAmount ?? 0;
        recalledRef.suilend = suilendPre;
        recalledRef.navi = naviPre;
        const total = recalledRef.deepbook + suilendPre + naviPre;
        setFlow(-1);
        if (r.recallDigest) setLastDigest(r.recallDigest);
        setChartEvents((es) => [...es, { tick: tickIndex, kind: "recall", amount: total }]);
        setBannerMsg({ tone: "red", text: `⚠ VOLATILITY TRIGGER · σ ${r.sigmaBps} bps · AUTO-DELEVERAGE · RECALLED ${usd(total)}` });
        onRefresh();
        setTimeout(() => setFlow(0), 900);
      }

      const released = wasTriggered && !r.triggered;
      if (released) {
        setFlow(1);
        const back = recalledRef.deepbook + recalledRef.suilend + recalledRef.navi;
        setChartEvents((es) => [...es, { tick: tickIndex, kind: "redeposit", amount: back }]);
        setBannerMsg({ tone: "green", text: `✓ VOLATILITY SUBSIDED ON-CHAIN (${SPCX_VOL.releaseNeeded} CALM PRINTS) · REDEPOSITING ${usd(back)}` });
        // real leg: the desk's own sponsored redeposit
        if (recalledRef.deepbook > 0) {
          try {
            const d = await rehypothecate(Math.floor(recalledRef.deepbook * 100) / 100);
            setLastDigest(d);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }
        // sim legs (simDeposit reads the store fresh internally)
        if (recalledRef.suilend > 0) simDeposit(instId, "suilend", recalledRef.suilend, aprs.suilend);
        if (recalledRef.navi > 0) simDeposit(instId, "navi", recalledRef.navi, aprs.navi);
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
    [instId, aprs.suilend, aprs.navi, rehypothecate, onRefresh],
  );

  async function runScenario() {
    if (running) {
      stopRef.current = true;
      return;
    }
    setError(null);
    setBannerMsg(null);
    setChartEvents([]);
    pointsRef.current = [{ price: mark, sigmaBps, triggered, releaseProgress }];
    setPoints(pointsRef.current);
    setFrameTicks(scenario.prices.length + 1);
    setRunning(true);
    stopRef.current = false;
    const recalledRef = { deepbook: 0, suilend: 0, navi: 0 };
    const openOtcs = otcIds.length ? otcIds : undefined;
    let wasTriggered = triggered;
    let callsPending = false;
    try {
      for (const price of scenario.prices) {
        if (stopRef.current) break;
        const t0 = Date.now();
        // with contracts armed, a latch tick cranks them FIRST (margin calls
        // while liquidity is deployed) instead of auto-recalling
        const r = await pushTick(instId, price, callsPending ? undefined : openOtcs);
        await applyTickResult(r, wasTriggered, recalledRef);
        wasTriggered = r.triggered;

        if (r.marginCalls?.length && !callsPending) {
          callsPending = true;
          setBannerMsg({
            tone: "red",
            text: `⚠ MM BREACH → MARGIN CALL on ${r.marginCalls.length} position${r.marginCalls.length > 1 ? "s" : ""} · pooled funds are deployed · cure window running`,
          });
          onRefresh();
          await new Promise((res) => setTimeout(res, 2600));
          if (autoCure && !stopRef.current) {
            const cu = await cureCalls(instId, otcIds);
            await applyCure(cu, recalledRef);
            wasTriggered = cu.triggered;
          }
        }
        const wait = scenario.cadenceMs - (Date.now() - t0);
        if (wait > 0) await new Promise((res) => setTimeout(res, wait));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      stopRef.current = false;
    }
  }

  /** Cure-step side effects: the recall event + "positions survive" banner. */
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

  async function doReset() {
    setError(null);
    setBusy("reset");
    try {
      const r = await resetOracle();
      setMarkState(r.mark);
      setTriggered(r.triggered);
      setSigmaBps(r.sigmaBps);
      setReleaseProgress(0);
      pointsRef.current = [];
      setPoints([]);
      setChartEvents([]);
      setFrameTicks(0);
      setBannerMsg(null);
      await poll();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // manual push — same on-chain machinery, one print at a time
  const manualRecalledRef = useRef({ deepbook: 0, suilend: 0, navi: 0 });
  async function doPush() {
    if (!Number.isFinite(spikePrice) || spikePrice <= 0) return;
    setError(null);
    setBusy("push");
    try {
      const wasTriggered = triggered;
      const r = willTrigger && !triggered ? await triggerAndRecall(instId, spikePrice) : await pushTick(instId, spikePrice);
      if (!points.length) setFrameTicks(0); // data-driven frame in manual mode
      await applyTickResult(r, wasTriggered, manualRecalledRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBannerMsg(null);
    } finally {
      setBusy(null);
    }
  }

  // ---- per-venue deploy / recall (DeepBook real; Suilend/Navi sim) ----
  async function venueDeploy(venue: "deepbook" | "suilend" | "navi") {
    const amt = Math.min(Number(amounts[venue]) || deployable, deployable);
    if (!state || amt <= 0) return;
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

  async function venueRecall(venue: "deepbook" | "suilend" | "navi") {
    const inVenue = venue === "deepbook" ? rehyp : venue === "suilend" ? suilendVal : naviVal;
    const amt = Math.min(Number(amounts[venue]) || inVenue, inVenue);
    if (!state || amt <= 0) return;
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

  return (
    <section className="relative mt-6 overflow-hidden rounded-[16px] border border-line-strong bg-surface">
      {bannerMsg && (
        <div
          className="fm-banner-in absolute inset-x-0 top-0 z-10 flex items-center justify-center gap-3 py-2.5 text-[13px] font-semibold tracking-[0.06em] text-bg"
          style={{ background: bannerMsg.tone === "green" ? "#1f6f4d" : "#b4341f" }}
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
            EWMA σ <span className="font-semibold text-ink">{sigmaBps} bps</span>
          </span>
          {triggered && (
            <span className="font-mono text-[12px] font-semibold" style={{ color: "#b4341f" }}>
              LATCHED · release {releaseProgress}/{SPCX_VOL.releaseNeeded}
            </span>
          )}
          <div className="text-right">
            <div className="flex items-center justify-end gap-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{SPCX.symbol}</span>
              <span className={`fm-pulse h-[6px] w-[6px] rounded-full ${triggered ? "bg-[#b4341f]" : "bg-[#1f6f4d]"}`} />
            </div>
            <div className="font-mono text-[22px] font-semibold text-ink">{usd(mark)}</div>
          </div>
        </div>
      </div>

      {/* scenario player + chart */}
      <div className="border-b border-line px-6 py-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div className="flex items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] font-medium uppercase tracking-[0.09em] text-muted">Oracle scenario</span>
              <select
                value={scenarioKey}
                onChange={(e) => setScenarioKey(e.target.value as ScenarioKey)}
                disabled={running}
                className="rounded-[7px] border border-line-strong bg-surface px-3 py-2 text-[13px] font-medium text-ink outline-none"
              >
                {SCENARIOS.map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </label>
            <button
              onClick={runScenario}
              disabled={!!busy}
              className={`rounded-[7px] border px-4 py-2 text-[13px] font-semibold transition-colors disabled:opacity-40 ${
                running ? "border-[#b4341f] text-[#b4341f] hover:bg-[#b4341f]/10" : "border-line-strong bg-ink text-bg hover:opacity-90"
              }`}
            >
              {running ? "■ Stop" : "▶ Run scenario"}
            </button>
            <button
              onClick={doReset}
              disabled={!!busy || running}
              className="rounded-[7px] border border-line-strong px-4 py-2 text-[13px] font-semibold text-ink transition-colors hover:bg-bg disabled:opacity-40"
            >
              {busy === "reset" ? "…" : "Reset"}
            </button>
            {otcIds.length > 0 && (
              <label className="ml-1 flex cursor-pointer items-center gap-1.5 pb-2 text-[11px] text-muted" title="On a margin call, run the permissionless recall + re-crank so positions pay and survive. Untick to let the cure window run out (liquidation drill).">
                <input type="checkbox" checked={autoCure} onChange={(e) => setAutoCure(e.target.checked)} className="accent-[#0f0f0f]" />
                auto-cure margin calls
              </label>
            )}
          </div>
          <p className="max-w-[360px] text-right text-[11px] leading-[1.5] text-muted">{scenario.blurb}. Every print is a real on-chain
            push; the recall is permissionless, the release is the oracle&apos;s own {SPCX_VOL.releaseNeeded}-print hysteresis.</p>
        </div>
        {points.length > 0 ? (
          <ScenarioChart
            points={points}
            events={chartEvents}
            totalTicks={frameTicks || points.length + 1}
            frame={frameTicks ? { priceMin: Math.min(...scenario.prices, mark), priceMax: Math.max(...scenario.prices, mark) } : undefined}
          />
        ) : (
          <div className="flex h-[120px] items-center justify-center rounded-[10px] border border-dashed border-line-strong">
            <p className="font-mono text-[12px] text-muted">▶ Run a scenario — the SPCX print stream, the EWMA σ signal, and the recall/redeposit marks draw here live.</p>
          </div>
        )}
      </div>

      {/* flow: liquid treasury — conduit — deployed across venues */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-0 px-6 py-6">
        <Vessel
          label="Liquid treasury · in protocol"
          big={usd(uiLiquid)}
          sub={reserved > 0 ? `posted IM ${usd(reserved)} fenced inside` : "no contracts yet"}
          pct={pool > 0 ? uiLiquid / pool : 0}
          tone="ink"
        />
        <Conduit flow={flow} />
        <Vessel
          label="Deployed · earning yield"
          big={usd(totalDeployed)}
          sub={interest > 0 ? `+${usd(interest, { maximumFractionDigits: 4 })} accrued on DeepBook` : totalDeployed > 0 ? "earning across venues" : "— idle —"}
          pct={pctDeployed}
          tone="green"
          subGreen={totalDeployed > 0}
        />
      </div>

      {/* per-venue cards */}
      <div className="grid gap-3 px-6 pb-5 sm:grid-cols-3">
        <VenueCard
          venue="deepbook"
          name="DeepBook margin"
          logo="/logos/deepbook.png"
          badge="real · testnet"
          badgeTone="green"
          value={rehyp}
          apr={aprs.deepbook}
          live={rates?.live.deepbook}
          amounts={amounts}
          setAmounts={setAmounts}
          busy={busy}
          onDeploy={() => venueDeploy("deepbook")}
          onRecall={() => venueRecall("deepbook")}
        />
        <VenueCard
          venue="suilend"
          name="Suilend"
          logo="/logos/suilend.png"
          badge="sim · live mainnet APR"
          badgeTone="muted"
          value={suilendVal}
          apr={aprs.suilend}
          live={rates?.live.suilend}
          amounts={amounts}
          setAmounts={setAmounts}
          busy={busy}
          onDeploy={() => venueDeploy("suilend")}
          onRecall={() => venueRecall("suilend")}
        />
        <VenueCard
          venue="navi"
          name="Navi"
          logo="/logos/navi.png"
          badge="sim · live mainnet APR"
          badgeTone="muted"
          value={naviVal}
          apr={aprs.navi}
          live={rates?.live.navi}
          amounts={amounts}
          setAmounts={setAmounts}
          busy={busy}
          onDeploy={() => venueDeploy("navi")}
          onRecall={() => venueRecall("navi")}
        />
      </div>

      {/* deploy gauge + on-chain liquidity floor */}
      <div className="px-6 pb-3">
        <div className="relative h-[6px] w-full overflow-hidden rounded-full bg-[rgba(0,0,0,0.07)]">
          <div
            className="absolute inset-y-0 left-0 rounded-full transition-[width] duration-700"
            style={{ width: `${pctDeployed * 100}%`, background: flow === -1 ? "#b4341f" : "var(--color-ink)" }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[11px] tracking-[0.08em] text-muted">
          <span>{Math.round(pctDeployed * 100)}% OF TREASURY EARNING · DEPLOYABLE {usd(deployable)}</span>
          <span>
            LIQUIDITY FLOOR {usd(floor)} <span className="text-faint">· deploys abort below it, on-chain</span>
          </span>
        </div>
      </div>

      {/* provenance */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line px-6 py-3 font-mono text-[11px] text-muted">
        <span className="text-[#1f6f4d]">● DeepBook leg real on testnet</span>
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
            className={`rounded-[7px] border px-4 py-2.5 text-[13px] font-semibold transition-colors disabled:opacity-40 ${willTrigger ? "border-[#b4341f] text-[#b4341f] hover:bg-[#b4341f] hover:text-bg" : "border-line-strong text-ink hover:bg-surface"}`}
          >
            {busy === "push" ? "…" : "Push print →"}
          </button>
        </div>
        <p className="font-mono text-[11px] leading-[1.5]">
          <span className={willTrigger ? "font-semibold text-[#b4341f]" : "text-muted"}>
            Δ {pushPct >= 0 ? "+" : ""}{pushPct.toFixed(1)}% vs {usd(mark)}
          </span>
          <span className="text-muted"> · latches beyond ±{latchPct.toFixed(1)}% (z &gt; {(SPCX_VOL.zLatchX100 / 100).toFixed(0)}σ at current σ) · </span>
          {willTrigger ? (
            <span className="text-[#b4341f]">would latch → permissionless recall</span>
          ) : (
            <span className="text-muted">in band{triggered ? ` → counts toward on-chain release (${releaseProgress}/${SPCX_VOL.releaseNeeded})` : ""}</span>
          )}
        </p>
      </div>

      {error && <p className="break-words px-6 pb-4 text-[12px] text-[#b4341f]">{error}</p>}
    </section>
  );
}

function VenueCard({
  venue,
  name,
  logo,
  badge,
  badgeTone,
  value,
  apr,
  live,
  amounts,
  setAmounts,
  busy,
  onDeploy,
  onRecall,
}: {
  venue: "deepbook" | "suilend" | "navi";
  name: string;
  logo: string;
  badge: string;
  badgeTone: "green" | "muted";
  value: number;
  apr: number;
  live?: boolean;
  amounts: Record<string, number | "">;
  setAmounts: React.Dispatch<React.SetStateAction<Record<string, number | "">>>;
  busy: string | null;
  onDeploy: () => void;
  onRecall: () => void;
}) {
  return (
    <div className="rounded-[12px] border border-line-strong bg-bg p-4">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Image src={logo} alt="" width={18} height={18} className="rounded-[4px]" />
          <span className="text-[13px] font-semibold text-ink">{name}</span>
        </span>
        <span
          className={`rounded-[4px] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.06em] ${
            badgeTone === "green" ? "bg-[#1f6f4d]/12 text-[#1a6042]" : "bg-[rgba(0,0,0,0.06)] text-muted"
          }`}
        >
          {badge}
        </span>
      </div>
      <div className="mt-3 flex items-baseline justify-between">
        <span className="font-mono text-[19px] font-semibold text-ink">{usd(value)}</span>
        <span className="font-mono text-[12px] font-semibold text-[#1a6042]">
          {apr.toFixed(2)}%{live === false ? "*" : ""} APR
        </span>
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <input
          type="number"
          placeholder="amount"
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
          className="shrink-0 rounded-[6px] border border-line-strong bg-ink px-2.5 py-1.5 text-[11.5px] font-semibold text-bg hover:opacity-90 disabled:opacity-40"
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
  const edge = tone === "green" ? "#1f6f4d" : "var(--color-ink)";
  const fill = tone === "green" ? "rgba(31,111,77,0.12)" : "rgba(15,15,15,0.07)";
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
        <p className={`font-mono text-[12px] ${subGreen ? "text-[#1f6f4d]" : "text-muted"}`}>{sub}</p>
      </div>
    </div>
  );
}

function Conduit({ flow }: { flow: Flow }) {
  const cls = flow === 1 ? "fm-flow-right" : flow === -1 ? "fm-flow-left" : "";
  const color = flow === -1 ? "#b4341f" : "var(--color-ink)";
  const caption = flow === 1 ? "DEPLOYING →" : flow === -1 ? "◄ RECALL" : "IDLE";
  return (
    <div className="flex w-[120px] flex-col items-center justify-center px-2">
      <svg width="120" height="40" viewBox="0 0 120 40" aria-hidden>
        <line x1="4" y1="20" x2="116" y2="20" stroke="var(--color-line-strong)" strokeWidth="1" />
        {flow !== 0 && (
          <line
            x1="4"
            y1="20"
            x2="116"
            y2="20"
            stroke={color}
            strokeWidth="2.5"
            strokeDasharray="6 10"
            className={cls}
          />
        )}
      </svg>
      <span className="font-mono text-[10px] tracking-[0.12em]" style={{ color: flow === -1 ? "#b4341f" : "var(--color-muted)" }}>
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
