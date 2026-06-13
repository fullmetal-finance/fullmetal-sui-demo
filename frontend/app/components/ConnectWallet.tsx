"use client";

import dynamic from "next/dynamic";

/* Wallet detection needs `window`, so the button must never render on the
   server — dynamic ssr:false from inside a client component. */
const ConnectButton = dynamic(
  () => import("@mysten/dapp-kit-react/ui").then((m) => m.ConnectButton),
  {
    ssr: false,
    loading: () => (
      <button
        disabled
        className="rounded-[7px] border-[0.5px] border-line px-4 py-2 text-[12px] tracking-[0.08em] text-muted"
      >
        Connect
      </button>
    ),
  },
);

export default function ConnectWallet() {
  return <ConnectButton />;
}
