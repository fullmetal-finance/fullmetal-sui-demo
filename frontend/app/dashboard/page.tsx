"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import Logo from "../components/Logo";
import SignInWithGoogle from "../components/SignInWithGoogle";
import CreateOtcModal from "../components/CreateOtcModal";
import LoadUsdModal from "../components/LoadUsdModal";
import MarginPanel from "../components/MarginPanel";
import RehypoHero from "../components/RehypoHero";
import Blotter from "../components/Blotter";
import TradersPanel from "../components/TradersPanel";
import QuotesInbox from "../components/QuotesInbox";
import MarketRfqs from "../components/MarketRfqs";
import RatesBar from "../components/RatesBar";
import { DBUSDC_TYPE, TARGET, explorer, usd } from "@/lib/fullmetal";
import { clearInstitution, loadInstitution, saveInstitution, saveQuotes, type InstitutionRecord } from "@/lib/store";
import { readAcceptedOffers, readInstitution, readUserContracts, type InstState } from "@/lib/institution-state";
import { clearSimVenues } from "@/lib/venues";
import { useSponsoredExecute } from "@/lib/sponsored";
import type { OtcResult } from "@/lib/otc";
import { MOCK_INCOMING_RFQS, MOCK_POSITIONS, positionPnl, type MockPosition } from "@/lib/mock";

type Tab = "positions" | "engine" | "rfq";

export default function Dashboard() {
  const account = useCurrentAccount();
  const sponsoredExecute = useSponsoredExecute();
  const [mounted, setMounted] = useState(false);
  const [rec, setRec] = useState<InstitutionRecord | null>(null);
  const [state, setState] = useState<InstState | null>(null);
  const [positions, setPositions] = useState<MockPosition[]>([]);
  const [tab, setTab] = useState<Tab>("positions");
  const [otcOpen, setOtcOpen] = useState(false);
  const [loadOpen, setLoadOpen] = useState(false);
  const [makersBusy, setMakersBusy] = useState(false);
  const [resetMsg, setResetMsg] = useState<string | null>(null);
  // unread RFQ-inbox badge: seeded with the standing incoming RFQs, bumped when
  // a broadcast RFQ draws quotes; cleared when the desk opens the tab.
  const [rfqUnread, setRfqUnread] = useState(MOCK_INCOMING_RFQS.length);
  const tabRef = useRef<Tab>("positions");
  const selectTab = useCallback((t: Tab) => {
    setTab(t);
    tabRef.current = t;
    if (t === "rfq") setRfqUnread(0);
  }, []);

  useEffect(() => {
    setMounted(true);
    if (account) setRec(loadInstitution(account.address));
  }, [account]);

  const refresh = useCallback(async (id: string) => {
    try {
      setState(await readInstitution(id));
    } catch {
      /* transient */
    }
  }, []);

  // re-poll a few times after an action so the UI catches up to propagation
  // instead of needing a manual refresh
  const sync = useCallback(
    async (id: string) => {
      for (let i = 0; i < 4; i++) {
        await refresh(id);
        if (i < 3) await new Promise((r) => setTimeout(r, 1000));
      }
    },
    [refresh],
  );

  // keep balances live without a manual refresh
  useEffect(() => {
    if (!rec) return;
    refresh(rec.institutionId);
    const t = setInterval(() => refresh(rec.institutionId), 4000);
    return () => clearInterval(t);
  }, [rec, refresh]);

  // record the desk's real on-chain contracts in the blotter; re-read alongside
  // the 4s state poll so marks/status stay live during the scenario
  useEffect(() => {
    if (!rec?.otcIds?.length) return;
    readUserContracts(rec.otcIds, rec.institutionId, rec.profile.adminName).then(setPositions).catch(() => {});
  }, [rec, state]);

  // proposed direct offers: once the counterparty accepts, fold the opened
  // OtcForward into the blotter and stop tracking the offer
  useEffect(() => {
    if (!account || !rec?.directOfferIds?.length) return;
    readAcceptedOffers(rec.directOfferIds)
      .then((accepted) => {
        if (!accepted.length) return;
        const cur = loadInstitution(account.address);
        if (!cur) return;
        const acceptedOffers = new Set(accepted.map((a) => a.offerId));
        const newOtcIds = accepted.map((a) => a.otcId).filter((id) => !(cur.otcIds ?? []).includes(id));
        const next = {
          ...cur,
          otcIds: [...(cur.otcIds ?? []), ...newOtcIds],
          directOfferIds: (cur.directOfferIds ?? []).filter((id) => !acceptedOffers.has(id)),
        };
        saveInstitution(account.address, next);
        setRec(next);
      })
      .catch(() => {});
  }, [account, rec, state]);

  const reload = useCallback(() => {
    if (account) {
      const r = loadInstitution(account.address);
      setRec(r);
      if (r) refresh(r.institutionId);
    }
  }, [account, refresh]);

  // Reset desk — LOCAL ONLY, zero transactions (nothing to fail): clears this
  // account's browser records so onboarding reopens with a fresh desk. The old
  // institution and its test funds simply stay parked on-chain.
  function doResetDesk() {
    if (!account || !rec) return;
    const ok = window.confirm(
      `Reset @${rec.handle}?\n\nClears this browser's records for the account and reopens onboarding — pick a NEW handle ("${rec.handle}" stays taken on-chain). The old institution's test funds stay parked on-chain; nothing is transacted.`,
    );
    if (!ok) return;
    for (const rfqId of rec.rfqIds ?? []) {
      localStorage.removeItem(`fullmetal:quotes:${rfqId}`);
    }
    clearSimVenues(rec.institutionId);
    clearInstitution(account.address);
    setResetMsg(`✓ Local records for @${rec.handle} cleared — create a fresh institution below with a new handle.`);
    setRec(null);
    setState(null);
    setPositions([]);
  }

  async function fund(amount: number) {
    if (!account || !rec) throw new Error("No institution.");
    const r = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: account.address, amount }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error ?? "faucet failed");
    if (!d.coinId) throw new Error("faucet did not return a coin");
    await sponsoredExecute((tx) => {
      tx.moveCall({
        target: TARGET.institution.deposit,
        typeArguments: [DBUSDC_TYPE],
        arguments: [tx.object(rec.institutionId), tx.object(rec.adminCapId), tx.object(d.coinId)],
      });
    });
    await sync(rec.institutionId);
  }

  async function onOtcCreated(res: OtcResult) {
    reload();
    if (rec) sync(rec.institutionId);
    if (res.kind === "rfq") {
      setMakersBusy(true);
      let count = 3;
      try {
        const r = await fetch("/api/makers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rfqId: res.offerId }),
        });
        const d = await r.json().catch(() => ({}));
        if (r.ok && d.quotes?.length) {
          saveQuotes(res.offerId, d.quotes);
          count = d.quotes.length;
        }
      } catch {
        /* makers offline — inbox shows preview */
      } finally {
        setMakersBusy(false);
      }
      // light up the RFQ tab — unless the desk is already looking at it
      if (tabRef.current !== "rfq") setRfqUnread((n) => n + count);
    }
  }

  // net variation margin that would settle in the next 24h cycle across the
  // desk's book (real on-chain contracts + demo positions). + = received, − = paid.
  const projectedSettlement = [...positions, ...MOCK_POSITIONS].reduce(
    (sum, p) => sum + positionPnl(p),
    0,
  );

  return (
    <div className="min-h-screen">
      <header className="w-full border-b border-line-strong bg-surface">
        <div className="mx-auto flex w-full max-w-[1320px] items-center justify-between px-6 py-3 sm:px-10">
          <Logo size="lg" />
          <SignInWithGoogle variant="nav" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1320px] px-6 py-10 sm:px-10 lg:py-12">
        {resetMsg && (
          <p className="mb-6 rounded-[10px] border border-line-strong bg-surface px-4 py-3 text-[13px] leading-[1.6] text-ink">
            {resetMsg}
          </p>
        )}
        {!mounted ? null : !account ? (
          <Empty title="Sign in to view your desk" cta={<Link href="/onboarding" className={linkCls}>Go to onboarding</Link>} />
        ) : !rec ? (
          <Empty title="No institution yet" cta={<Link href="/onboarding" className={linkCls}>Create one →</Link>} />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                {/* role context — Admin now; trader mode would read "Trader · <name>" */}
                <span className="eyebrow">Institutional desk · Admin</span>
                <h1 className="mt-4 text-[34px] font-semibold leading-[1.05] tracking-[-0.02em]">{rec.profile.legalName || rec.handle}</h1>
                <div className="mt-2 flex items-center gap-3 font-mono text-[12px] text-muted">
                  <span className="flex items-center gap-1.5 text-ink"><span className="h-[6px] w-[6px] rounded-full bg-[#1f6f4d]" /> LIVE</span>
                  <span>@{rec.handle}</span>
                  <a href={explorer.object(rec.institutionId)} target="_blank" rel="noreferrer" className="underline hover:text-ink">inst {rec.institutionId.slice(0, 6)}… ↗</a>
                  <button
                    onClick={doResetDesk}
                    title="Clear this account's local records and reopen onboarding (no transactions)"
                    className="underline decoration-dotted underline-offset-2 hover:text-ink"
                  >
                    ↺ reset desk
                  </button>
                </div>
              </div>
              <div className="flex gap-2.5">
                <button onClick={() => setLoadOpen(true)} className="rounded-[8px] border border-line-strong px-4 py-2.5 text-[13px] font-medium text-ink transition-colors hover:bg-surface">Load funds</button>
                <button onClick={() => setOtcOpen(true)} className="rounded-[8px] border border-line-strong bg-ink px-4 py-2.5 text-[13px] font-semibold text-bg transition-opacity hover:opacity-90">New OTC contract →</button>
              </div>
            </div>

            {/* treasury strip */}
            <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
              <BigStat label="Total capital" value={state ? usd(state.equity) : "—"} sub="treasury + deployed" accent />
              <BigStat label="Available" value={state ? usd(state.available) : "—"} sub="free to deploy" />
              <BigStat label="Reserved IM" value={state ? usd(state.reserved) : "—"} />
              <BigStat label="Rehypothecated" value={state ? usd(state.rehypothecated) : "—"} sub="in DeepBook" />
              <BigStat
                label="Projected 24h settlement"
                value={`${projectedSettlement >= 0 ? "+" : "−"}${usd(Math.abs(projectedSettlement), { maximumFractionDigits: 0 })}`}
                sub={projectedSettlement >= 0 ? "net VM to receive" : "net VM to pay"}
                tone={projectedSettlement >= 0 ? "up" : "down"}
              />
            </div>

            {/* live USDC supply yield across venues */}
            <RatesBar />

            {/* unified tabbed panel — the strip is the header of the content
                container, so the active tab opens into the body below it */}
            <div className="mt-8 overflow-hidden rounded-[16px] border border-line-strong">
              <div className="flex divide-x divide-line-strong border-b border-line-strong">
                <PanelTab active={tab === "positions"} onClick={() => selectTab("positions")}>Positions &amp; traders</PanelTab>
                <PanelTab active={tab === "rfq"} onClick={() => selectTab("rfq")}>
                  RFQ inbox
                  {rfqUnread > 0 && (
                    <span className="ml-2 inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-[#b4341f] px-1 align-middle text-[10px] font-bold leading-none text-bg">
                      {rfqUnread}
                    </span>
                  )}
                  {makersBusy && <span className="ml-1.5 inline-block h-[5px] w-[5px] animate-pulse rounded-full bg-[#1f6f4d] align-middle" />}
                </PanelTab>
                <PanelTab active={tab === "engine"} onClick={() => selectTab("engine")}>Collateral manager</PanelTab>
              </div>

              <div
                className="p-4 sm:p-5"
                style={{ background: "color-mix(in srgb, var(--ink) 5%, var(--bg))" }}
              >
                {tab === "positions" && (
                  <div className="space-y-6">
                    <MarginPanel state={state} positions={positions} onRefresh={() => sync(rec.institutionId)} />
                    <Blotter real={positions} />
                    <TradersPanel />
                  </div>
                )}
                {tab === "engine" && (
                  <RehypoHero
                    instId={rec.institutionId}
                    state={state}
                    // arm only OPEN, UNEXPIRED contracts (settle_on_breach aborts
                    // on expired ones — those settle via close)
                    otcIds={(rec.otcIds ?? []).filter((id) =>
                      positions.find(
                        (p) =>
                          p.otcId === id &&
                          (p.status ?? 0) === 0 &&
                          !((p.expiryMs ?? 0) > 0 && Date.now() >= (p.expiryMs ?? 0)),
                      ),
                    )}
                    onRefresh={() => sync(rec.institutionId)}
                  />
                )}
                {tab === "rfq" && (
                  <div className="space-y-6">
                    <QuotesInbox
                      rfqIds={rec.rfqIds ?? []}
                      loading={makersBusy}
                      onAccepted={(otcId) => {
                        if (account) {
                          const next = { ...rec, otcIds: [...(rec.otcIds ?? []), otcId] };
                          saveInstitution(account.address, next);
                          setRec(next);
                        }
                        reload();
                      }}
                    />
                    <MarketRfqs />
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      <CreateOtcModal open={otcOpen} onClose={() => setOtcOpen(false)} onCreated={onOtcCreated} />
      <LoadUsdModal open={loadOpen} onClose={() => setLoadOpen(false)} fund={fund} />
    </div>
  );
}

function PanelTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-4 py-3.5 text-center text-[14px] font-semibold transition-colors ${
        active
          ? "bg-ink text-bg"
          : "bg-surface text-ink-soft hover:bg-bg hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function BigStat({ label, value, sub, accent, tone }: { label: string; value: string; sub?: string; accent?: boolean; tone?: "up" | "down" }) {
  const valueColor = tone === "up" ? "text-[#1a6042]" : tone === "down" ? "text-[#9a2c1a]" : "text-ink";
  return (
    <div className={`rounded-[14px] border bg-surface px-6 py-5 ${accent ? "border-line-strong" : "border-line"}`}>
      <p className="text-[11px] font-semibold uppercase tracking-[0.13em] text-muted">{label}</p>
      <p className={`mt-2.5 font-mono text-[26px] font-semibold tracking-[-0.01em] ${valueColor}`}>{value}</p>
      {sub && <p className="mt-0.5 text-[12px] text-muted">{sub}</p>}
    </div>
  );
}

function Empty({ title, cta }: { title: string; cta: React.ReactNode }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-start justify-center">
      <h1 className="text-2xl font-semibold tracking-[-0.01em]">{title}</h1>
      <div className="mt-6">{cta}</div>
    </div>
  );
}

const linkCls =
  "rounded-[8px] border border-line-strong px-4 py-2.5 text-[14px] font-medium text-ink transition-colors hover:bg-surface";
