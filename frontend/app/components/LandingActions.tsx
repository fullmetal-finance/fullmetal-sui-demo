"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useCurrentAccount,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react";

import { loadInstitution } from "@/lib/store";

const GOOGLE_WALLET_NAME = "Sign in with Google";

/** The front-door paths:
 *  • Create your institution desk → onboarding (admin spins up an org).
 *  • Sign in → existing traders/admins authenticate with Google (zkLogin).
 *  Once an institution is registered on the signed-in account, BOTH collapse
 *  to a single "Go to your desk" — creating a second one would just re-open the
 *  form, so we route straight to the dashboard instead. */
export default function LandingActions() {
  const router = useRouter();
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [mounted, setMounted] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [hasInstitution, setHasInstitution] = useState(false);
  useEffect(() => setMounted(true), []);

  // Reflect whether this account already has a desk (localStorage is browser-only).
  useEffect(() => {
    setHasInstitution(account ? Boolean(loadInstitution(account.address)) : false);
  }, [account]);

  const googleWallet = mounted
    ? wallets.find((w) => w.name === GOOGLE_WALLET_NAME)
    : undefined;

  // Once a sign-in completes, route to the desk.
  useEffect(() => {
    if (signingIn && account) router.push("/dashboard");
  }, [signingIn, account, router]);

  async function signIn() {
    if (account) {
      router.push("/dashboard");
      return;
    }
    setSigningIn(true);
    try {
      if (googleWallet) await dAppKit.connectWallet({ wallet: googleWallet });
    } catch {
      setSigningIn(false);
    }
  }

  // Returning, signed-in desk → straight to the dashboard, no registration form.
  if (mounted && account && hasInstitution) {
    return (
      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/dashboard" className={primaryCls}>
          Go to your desk →
        </Link>
        <button onClick={() => dAppKit.disconnectWallet()} className={secondaryCls}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Link href="/onboarding" className={primaryCls}>
        Create your institution desk →
      </Link>
      <button
        onClick={signIn}
        disabled={!mounted || (!googleWallet && !account)}
        className={secondaryCls}
      >
        {account ? "Go to your desk →" : signingIn ? "Signing in…" : "Sign in"}
      </button>
    </div>
  );
}

const primaryCls =
  "flex items-center justify-center rounded-[7px] border-[0.5px] border-line-strong bg-ink px-6 py-3.5 text-[14px] text-bg transition-opacity hover:opacity-90";
const secondaryCls =
  "flex items-center justify-center rounded-[7px] border-[0.5px] border-line-strong px-6 py-3.5 text-[14px] text-ink transition-colors hover:bg-surface disabled:opacity-40";
