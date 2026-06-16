"use client";

import Link from "next/link";
import { useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import Logo from "../components/Logo";
import SignInWithGoogle from "../components/SignInWithGoogle";

type Profile = {
  legalName: string;
  email: string;
  phone: string;
  address: string;
  jurisdiction: string;
  handle: string;
};

const EMPTY: Profile = {
  legalName: "",
  email: "",
  phone: "",
  address: "",
  jurisdiction: "",
  handle: "",
};

export default function Onboarding() {
  const account = useCurrentAccount();
  const [p, setP] = useState<Profile>(EMPTY);
  const [logo, setLogo] = useState<string | null>(null);

  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP((prev) => ({ ...prev, [k]: e.target.value }));

  const profileComplete =
    p.legalName.trim() && p.email.trim() && p.handle.trim();

  return (
    <main className="mx-auto w-full max-w-[1120px] px-4 pt-4 sm:px-6">
      {/* header */}
      <header className="flex items-center justify-between py-3">
        <Logo size="sm" />
        <SignInWithGoogle variant="nav" />
      </header>

      <div className="grid gap-12 py-12 lg:grid-cols-[1fr_1.1fr] lg:gap-20 lg:py-20">
        {/* left rail — the pitch */}
        <section className="flex flex-col justify-center">
          <span className="eyebrow">Institutional onboarding</span>
          <h1 className="mt-6 max-w-[440px] text-3xl leading-[1.18] tracking-[-0.01em] sm:text-4xl">
            Open your desk in minutes — no seed phrases, no gas.
          </h1>
          <p className="mt-6 max-w-[420px] text-[15px] leading-[1.9] text-ink-soft">
            Fullmetal is institutional OTC derivatives on Sui. Sign in with your
            corporate Google account; settlement happens in USDC, and your posted
            margin earns lending yield until risk triggers pull it back.
          </p>

          <ul className="mt-10 space-y-4">
            {[
              ["zkLogin identity", "Corporate SSO via Google — no wallet, no keys."],
              ["Gasless by default", "Transactions are sponsored. Users never hold SUI."],
              ["Yield on idle margin", "Reserved collateral is rehypothecated to DeepBook."],
            ].map(([t, d]) => (
              <li key={t} className="flex gap-3">
                <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-line-strong" />
                <span className="text-[14px] leading-[1.7]">
                  <span className="text-ink">{t}</span>
                  <span className="text-muted"> — {d}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* right — the form card */}
        <section className="rounded-[16px] border-[0.5px] border-line bg-surface p-7 sm:p-9">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
              Step 1 · Institution profile
            </p>
            <p className="font-mono text-[11px] tracking-[0.12em] text-faint">1 / 3</p>
          </div>

          <div className="mt-7 grid gap-5">
            <Field label="Legal entity name" placeholder="Goldwoman Socks LLC">
              <input className={inputCls} value={p.legalName} onChange={set("legalName")} placeholder="Goldwoman Socks LLC" />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Work email">
                <input className={inputCls} type="email" value={p.email} onChange={set("email")} placeholder="desk@goldwoman.com" />
              </Field>
              <Field label="Phone">
                <input className={inputCls} value={p.phone} onChange={set("phone")} placeholder="+1 212 555 0100" />
              </Field>
            </div>

            <Field label="Business address">
              <input className={inputCls} value={p.address} onChange={set("address")} placeholder="200 West St, New York, NY" />
            </Field>

            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Jurisdiction">
                <input className={inputCls} value={p.jurisdiction} onChange={set("jurisdiction")} placeholder="Delaware, US" />
              </Field>
              <Field label="Institution ID" hint="unique on-chain handle">
                <input
                  className={`${inputCls} font-mono`}
                  value={p.handle}
                  onChange={(e) =>
                    setP((prev) => ({
                      ...prev,
                      handle: e.target.value.toLowerCase().replace(/[^a-z0-9]/g, ""),
                    }))
                  }
                  placeholder="goldwomansocks"
                />
              </Field>
            </div>

            <Field label="Logo" hint="optional">
              <label className="flex cursor-pointer items-center gap-4">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[7px] border-[0.5px] border-line bg-bg">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="logo preview" className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-[18px] text-faint">+</span>
                  )}
                </span>
                <span className="text-[13px] text-muted">
                  {logo ? "Replace image" : "Upload a square logo"}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) setLogo(URL.createObjectURL(f));
                  }}
                />
              </label>
            </Field>
          </div>

          {/* sign-in / continue */}
          <div className="mt-8 border-t-[0.5px] border-line pt-7">
            {!account ? (
              <>
                <SignInWithGoogle
                  variant="cta"
                  label={profileComplete ? "Continue with Google" : "Sign in with Google"}
                />
                <p className="mt-3 text-center text-[12px] leading-[1.7] text-muted">
                  We&apos;ll create your institution on-chain after sign-in.
                  Settlement verified on Sui; everything else feels like signing
                  into any SaaS.
                </p>
              </>
            ) : (
              <div className="space-y-4">
                <SignInWithGoogle variant="cta" />
                <Link
                  href="/dashboard"
                  className="flex w-full items-center justify-center gap-2 rounded-[7px] border-[0.5px] border-line-strong px-4 py-3 text-[14px] text-ink transition-colors hover:bg-bg"
                >
                  Continue → Fund treasury
                </Link>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

const inputCls =
  "w-full rounded-[7px] border-[0.5px] border-line bg-bg px-3 py-2.5 text-[14px] text-ink placeholder:text-faint outline-none transition-colors focus:border-line-strong";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-2 flex items-baseline gap-2">
        <span className="text-[12px] tracking-[0.04em] text-ink-soft">{label}</span>
        {hint && <span className="text-[11px] text-faint">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}
