"use client";

import { useEffect, useState } from "react";
import {
  useCurrentAccount,
  useDAppKit,
  useWallets,
} from "@mysten/dapp-kit-react";

/* Enoki registers its zkLogin wallet under this exact name. Matching by name is
   robust against UiWallet vs wallet-standard Wallet shape differences. */
const GOOGLE_WALLET_NAME = "Sign in with Google";

/** Reusable Google zkLogin sign-in. `variant="nav"` is the small header pill;
    `variant="cta"` is the prominent onboarding button. No seed phrase, no wallet
    popup — Enoki derives a Sui address from the Google identity.

    Wallet state only exists in the browser, so everything wallet-dependent is
    gated behind `mounted`: the server and first client paint render an identical
    disabled, signed-out button (no hydration mismatch), then it goes live. */
export default function SignInWithGoogle({
  variant = "nav",
  label = "Sign in with Google",
}: {
  variant?: "nav" | "cta";
  label?: string;
}) {
  const dAppKit = useDAppKit();
  const wallets = useWallets();
  const account = useCurrentAccount();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const googleWallet = mounted
    ? wallets.find((w) => w.name === GOOGLE_WALLET_NAME)
    : undefined;

  // Signed-in view (only after mount; the server never has an account).
  if (mounted && account) {
    const short = `${account.address.slice(0, 6)}…${account.address.slice(-4)}`;
    if (variant === "cta") {
      return (
        <div className="flex items-center justify-between rounded-[7px] border-[0.5px] border-line bg-surface px-4 py-3">
          <span className="font-mono text-[12px] text-ink-soft">
            <span className="text-muted">Signed in · </span>
            {short}
          </span>
          <button
            onClick={() => dAppKit.disconnectWallet()}
            className="text-[12px] tracking-[0.08em] text-muted transition-colors hover:text-ink"
          >
            Sign out
          </button>
        </div>
      );
    }
    return (
      <button
        onClick={() => dAppKit.disconnectWallet()}
        className="rounded-[7px] border-[0.5px] border-line px-4 py-2 text-[12px] tracking-[0.08em] text-muted transition-colors hover:text-ink"
      >
        {short} · Sign out
      </button>
    );
  }

  // Signed-out view. Disabled until the Enoki wallet is registered in-browser.
  const disabled = !mounted || !googleWallet;
  const onClick = () =>
    googleWallet && dAppKit.connectWallet({ wallet: googleWallet });

  if (variant === "cta") {
    return (
      <button
        disabled={disabled}
        onClick={onClick}
        className="flex w-full items-center justify-center gap-3 rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-3 text-[14px] text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
      >
        <GoogleMark />
        {label}
      </button>
    );
  }

  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="rounded-[7px] border-[0.5px] border-line px-4 py-2 text-[12px] tracking-[0.08em] text-ink transition-opacity disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function GoogleMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden>
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.47.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}
