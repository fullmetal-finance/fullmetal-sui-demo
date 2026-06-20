"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import Logo from "../components/Logo";
import SignInWithGoogle from "../components/SignInWithGoogle";
import CreateOtcModal from "../components/CreateOtcModal";
import { explorer } from "@/lib/fullmetal";
import { loadInstitution, type InstitutionRecord } from "@/lib/store";

export default function Dashboard() {
  const account = useCurrentAccount();
  const [mounted, setMounted] = useState(false);
  const [rec, setRec] = useState<InstitutionRecord | null>(null);
  const [otcOpen, setOtcOpen] = useState(false);

  useEffect(() => {
    setMounted(true);
    if (account) setRec(loadInstitution(account.address));
  }, [account]);

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
          <Empty
            title="Sign in to view your desk"
            cta={<Link href="/onboarding" className={linkCls}>Go to onboarding</Link>}
          />
        ) : !rec ? (
          <Empty
            title="No institution yet"
            cta={<Link href="/onboarding" className={linkCls}>Create one →</Link>}
          />
        ) : (
          <section className="max-w-[760px]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <span className="eyebrow">Treasury</span>
                <h1 className="mt-5 text-3xl tracking-[-0.01em]">{rec.profile.legalName || rec.handle}</h1>
                <p className="mt-2 font-mono text-[13px] text-muted">@{rec.handle}</p>
              </div>
              <button
                onClick={() => setOtcOpen(true)}
                className="shrink-0 rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-2.5 text-[13px] text-bg transition-opacity hover:opacity-90"
              >
                New OTC contract →
              </button>
            </div>

            <div className="mt-8 grid gap-4 sm:grid-cols-2">
              <Stat label="Institution" value={short(rec.institutionId)} href={explorer.object(rec.institutionId)} />
              <Stat label="Admin capability" value={short(rec.adminCapId)} href={explorer.object(rec.adminCapId)} />
              <Stat label="Created (tx)" value={short(rec.txDigest)} href={explorer.tx(rec.txDigest)} />
              <Stat label="Treasury balance" value="$0.00" sub="fund it next →" />
            </div>

            <div className="mt-8 rounded-[16px] border-[0.5px] border-line bg-surface p-6">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                Step 2 · Fund treasury
              </p>
              <p className="mt-3 text-[14px] leading-[1.7] text-ink-soft">
                Load USD to mint DBUSDC into your treasury. Wiring next.
              </p>
              <button
                disabled
                className="mt-5 rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-3 text-[14px] text-bg opacity-40"
              >
                Load USD (coming)
              </button>
            </div>
          </section>
        )}
      </main>

      <CreateOtcModal open={otcOpen} onClose={() => setOtcOpen(false)} />
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  href,
}: {
  label: string;
  value: string;
  sub?: string;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted">{label}</p>
      <p className="mt-2 font-mono text-[15px] text-ink">{value}</p>
      {sub && <p className="mt-1 text-[12px] text-faint">{sub}</p>}
    </>
  );
  const cls = "block rounded-[12px] border-[0.5px] border-line bg-surface p-5";
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
