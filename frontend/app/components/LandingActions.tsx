"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  useCurrentAccount,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react";

const GOOGLE_WALLET_NAME = "Sign in with Google";

/** The two front-door paths:
 *  • Create your institution desk → the onboarding flow (admin spins up an org).
 *  • Sign in → existing traders/admins authenticate with Google (zkLogin) and
 *    land on their desk. Same identity primitive, different intent. */
export default function LandingActions() {
  const router = useRouter();
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const [mounted, setMounted] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => setMounted(true), []);

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

  return (
    <div className="flex flex-col gap-3 sm:flex-row">
      <Link
        href="/onboarding"
        className="flex items-center justify-center rounded-[7px] border-[0.5px] border-line-strong bg-ink px-6 py-3.5 text-[14px] text-bg transition-opacity hover:opacity-90"
      >
        Create your institution desk →
      </Link>
      <button
        onClick={signIn}
        disabled={!mounted || (!googleWallet && !account)}
        className="flex items-center justify-center rounded-[7px] border-[0.5px] border-line-strong px-6 py-3.5 text-[14px] text-ink transition-colors hover:bg-surface disabled:opacity-40"
      >
        {account ? "Go to your desk →" : signingIn ? "Signing in…" : "Sign in"}
      </button>
    </div>
  );
}
