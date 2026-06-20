"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import Logo from "../components/Logo";
import SignInWithGoogle from "../components/SignInWithGoogle";
import CreateOtcModal from "../components/CreateOtcModal";
import AcceptQuote from "../components/AcceptQuote";
import { DBUSDC_TYPE, TARGET, explorer, usd } from "@/lib/fullmetal";
import { loadInstitution, type InstitutionRecord } from "@/lib/store";
import { readInstitution, type InstState } from "@/lib/institution-state";
import { useSponsoredExecute } from "@/lib/sponsored";

const LOAD_AMOUNT = 50;

export default function Dashboard() {
  const account = useCurrentAccount();
  const sponsoredExecute = useSponsoredExecute();
  const [mounted, setMounted] = useState(false);
  const [rec, setRec] = useState<InstitutionRecord | null>(null);
  const [state, setState] = useState<InstState | null>(null);
  const [otcOpen, setOtcOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
    if (account) setRec(loadInstitution(account.address));
  }, [account]);

  const refresh = useCallback(async (id: string) => {
    try {
      setState(await readInstitution(id));
    } catch {
      /* transient RPC */
    }
  }, []);

  useEffect(() => {
    if (rec) refresh(rec.institutionId);
  }, [rec, refresh]);

  async function loadUsd() {
    if (!account || !rec) return;
    setError(null);
    setBusy(true);
    try {
      // 1) mock fiat on-ramp — faucet DBUSDC into the signed-in address
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: account.address, amount: LOAD_AMOUNT }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "faucet failed");
      if (!d.coinId) throw new Error("faucet did not return a coin");

      // 2) gasless deposit of the exact faucet coin into the institution treasury
      await sponsoredExecute((tx) => {
        tx.moveCall({
          target: TARGET.institution.deposit,
          typeArguments: [DBUSDC_TYPE],
          arguments: [tx.object(rec.institutionId), tx.object(rec.adminCapId), tx.object(d.coinId)],
        });
      });
      await refresh(rec.institutionId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="w-full border-b-[0.5px] border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-4 py-3 sm:px-6">
          <Logo size="lg" />
          <SignInWithGoogle variant="nav" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1120px] px-4 py-12 sm:px-6 lg:py-16">
        {!mounted ? null : !account ? (
          <Empty title="Sign in to view your desk" cta={<Link href="/onboarding" className={linkCls}>Go to onboarding</Link>} />
        ) : !rec ? (
          <Empty title="No institution yet" cta={<Link href="/onboarding" className={linkCls}>Create one →</Link>} />
        ) : (
          <section className="max-w-[820px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="eyebrow">Treasury</span>
                <h1 className="mt-5 text-3xl tracking-[-0.01em]">{rec.profile.legalName || rec.handle}</h1>
                <p className="mt-2 font-mono text-[13px] text-muted">@{rec.handle}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  onClick={loadUsd}
                  disabled={busy}
                  className="rounded-[7px] border-[0.5px] border-line-strong px-4 py-2.5 text-[13px] text-ink transition-colors hover:bg-surface disabled:opacity-40"
                >
                  {busy ? "Loading…" : `Load $${LOAD_AMOUNT} USD`}
                </button>
                <button
                  onClick={() => setOtcOpen(true)}
                  className="rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-2.5 text-[13px] text-bg transition-opacity hover:opacity-90"
                >
                  New OTC contract →
                </button>
              </div>
            </div>

            {error && <p className="mt-4 break-words text-[12px] text-[#b4341f]">{error}</p>}

            {/* live balances */}
            <div className="mt-8 grid gap-4 sm:grid-cols-4">
              <Stat label="Equity" value={state ? usd(state.equity) : "—"} accent />
              <Stat label="Available" value={state ? usd(state.available) : "—"} />
              <Stat label="Reserved IM" value={state ? usd(state.reserved) : "—"} />
              <Stat label="Rehypothecated" value={state ? usd(state.rehypothecated) : "—"} sub="earning yield" />
            </div>

            {/* identity */}
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <Stat label="Institution" value={short(rec.institutionId)} href={explorer.object(rec.institutionId)} />
              <Stat label="Admin capability" value={short(rec.adminCapId)} href={explorer.object(rec.adminCapId)} />
              <Stat label="Created (tx)" value={short(rec.txDigest)} href={explorer.tx(rec.txDigest)} />
            </div>

            {state && state.liquid === 0 && state.reserved === 0 && (
              <p className="mt-6 text-[13px] leading-[1.7] text-muted">
                Treasury is empty — hit <span className="text-ink">Load ${LOAD_AMOUNT} USD</span> to mint DBUSDC in, then open a contract.
              </p>
            )}

            <AcceptQuote onAccepted={() => refresh(rec.institutionId)} />
          </section>
        )}
      </main>

      <CreateOtcModal
        open={otcOpen}
        onClose={() => setOtcOpen(false)}
        onCreated={() => rec && refresh(rec.institutionId)}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  href,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
  accent?: boolean;
}) {
  const body = (
    <>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className={`mt-2 font-mono text-[15px] ${accent ? "text-ink" : "text-ink"}`}>{value}</p>
      {sub && <p className="mt-1 text-[12px] text-faint">{sub}</p>}
    </>
  );
  const cls = `block rounded-[12px] border-[0.5px] bg-surface p-5 ${accent ? "border-line-strong" : "border-line"}`;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={`${cls} transition-colors hover:border-line-strong`}>
      {body}
    </a>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Empty({ title, cta }: { title: string; cta: React.ReactNode }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-start justify-center">
      <h1 className="text-2xl tracking-[-0.01em]">{title}</h1>
      <div className="mt-6">{cta}</div>
    </div>
  );
}

const linkCls =
  "rounded-[7px] border-[0.5px] border-line-strong px-4 py-2.5 text-[14px] text-ink transition-colors hover:bg-surface";

const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-6)}`;
