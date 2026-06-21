"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useCurrentAccount } from "@mysten/dapp-kit-react";

import Logo from "../components/Logo";
import SignInWithGoogle from "../components/SignInWithGoogle";
import { DBUSDC_TYPE, SHARED, TARGET } from "@/lib/fullmetal";
import { useSponsoredExecute } from "@/lib/sponsored";
import { createdId, suiRead } from "@/lib/sui";
import { loadInstitution, saveInstitution } from "@/lib/store";

type Profile = {
  adminName: string;
  legalName: string;
  email: string;
  phone: string;
  address: string;
  jurisdiction: string;
  handle: string;
};

const EMPTY: Profile = {
  adminName: "",
  legalName: "",
  email: "",
  phone: "",
  address: "",
  jurisdiction: "",
  handle: "",
};

export default function Onboarding() {
  const account = useCurrentAccount();
  const router = useRouter();
  const sponsoredExecute = useSponsoredExecute();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const [p, setP] = useState<Profile>(EMPTY);
  const [logo, setLogo] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Session is only known in-browser; gate account-dependent UI behind mount so
  // server and first client paint match (no hydration mismatch).
  const signedIn = mounted && account;

  // If this account already registered an institution, onboarding is a dead end —
  // send it straight to the dashboard instead of showing the form again. Covers
  // every route in here: the landing button, dashboard empty-state links, the
  // back button, or a bookmarked /onboarding URL.
  const existing = mounted && account ? loadInstitution(account.address) : null;
  useEffect(() => {
    if (existing) router.replace("/dashboard");
  }, [existing, router]);

  const set = (k: keyof Profile) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setP((prev) => ({ ...prev, [k]: e.target.value }));

  const profileComplete = Boolean(
    p.adminName.trim() && p.legalName.trim() && p.email.trim() && p.handle.trim(),
  );

  async function createInstitution() {
    if (!account) return;
    setError(null);
    setCreating(true);
    try {
      const digest = await sponsoredExecute((tx) => {
        const cap = tx.moveCall({
          target: TARGET.institution.create,
          typeArguments: [DBUSDC_TYPE],
          arguments: [tx.object(SHARED.handleRegistry), tx.pure.string(p.handle)],
        });
        tx.transferObjects([cap], account!.address);
      });
      await suiRead.waitForTransaction({ digest });
      const full = await suiRead.getTransactionBlock({
        digest,
        options: { showObjectChanges: true },
      });
      saveInstitution(account.address, {
        handle: p.handle,
        institutionId: createdId(full, "::institution::Institution<"),
        adminCapId: createdId(full, "::institution::AdminCap"),
        profile: {
          adminName: p.adminName,
          legalName: p.legalName,
          email: p.email,
          phone: p.phone,
          address: p.address,
          jurisdiction: p.jurisdiction,
        },
        logo,
        txDigest: digest,
        createdAt: Date.now(),
      });
      router.push("/dashboard");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  // Returning desk: render nothing but a brief notice while the redirect fires.
  if (existing) {
    return (
      <div className="flex min-h-dvh items-center justify-center px-6">
        <p className="font-mono text-[12px] uppercase tracking-[0.18em] text-muted">
          Taking you to your desk…
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* full-bleed surface header — matches the logo's background so it blends */}
      <header className="w-full border-b-[0.5px] border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-4 py-3 sm:px-6">
          <Logo size="lg" />
          <SignInWithGoogle variant="nav" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
        <div className="mx-auto max-w-[560px] py-12 lg:py-16">
          {/* the form card */}
          <section className="rounded-[16px] border-[0.5px] border-line bg-surface p-7 sm:p-9">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">
                Step 1 · Institution profile
              </p>
              <p className="font-mono text-[11px] tracking-[0.12em] text-faint">1 / 3</p>
            </div>

            <div className="mt-7 grid gap-5">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Your name" hint="shown on contracts you open">
                  <input className={inputCls} value={p.adminName} onChange={set("adminName")} placeholder="Jamie Dimon" />
                </Field>
                <Field label="Legal entity name">
                  <input className={inputCls} value={p.legalName} onChange={set("legalName")} placeholder="Goldwoman Socks LLC" />
                </Field>
              </div>

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

            {/* sign-in / create */}
            <div className="mt-8 border-t-[0.5px] border-line pt-7">
              {!signedIn ? (
                <SignInWithGoogle
                  variant="cta"
                  label={profileComplete ? "Continue with Google" : "Sign in with Google"}
                />
              ) : (
                <div className="space-y-4">
                  <SignInWithGoogle variant="cta" />
                  <button
                    disabled={!profileComplete || creating}
                    onClick={createInstitution}
                    className="flex w-full items-center justify-center rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-3 text-[14px] text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
                  >
                    {creating ? "Creating institution on-chain…" : "Create institution →"}
                  </button>
                  {!profileComplete && (
                    <p className="text-center text-[12px] text-muted">
                      Add your name, legal name, email, and an institution ID to continue.
                    </p>
                  )}
                  {error && (
                    <p className="break-words text-[12px] leading-[1.6] text-[#b4341f]">
                      {error}
                    </p>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
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
