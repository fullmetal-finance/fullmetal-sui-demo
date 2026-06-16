"use client";

import { useEffect } from "react";

/* Enoki's Google login opens this URL in a popup; the opener reads the JWT from
   the URL hash and closes us. Nothing to do here except give the popup a real
   page on our origin to land on. Register this exact path
   (http://localhost:3000/auth/callback in dev) as the OAuth redirect URI. */
export default function AuthCallback() {
  useEffect(() => {
    if (window.opener) {
      const t = setTimeout(() => window.close(), 2000);
      return () => clearTimeout(t);
    }
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center">
      <p className="text-[13px] tracking-[0.08em] text-muted">Signing you in…</p>
    </main>
  );
}
