import Logo from "./components/Logo";
import LandingActions from "./components/LandingActions";
import RehypoShowcase from "./components/RehypoShowcase";
import SignInWithGoogle from "./components/SignInWithGoogle";

/* ------------------------------------------------------------------ */
/*  Landing page — locked to a single viewport (no scroll) for the      */
/*  demo recording. Two-column hero: the pitch + CTAs on the left, and   */
/*  the feature/venue wall that cross-fades into the animated risk-       */
/*  responsive-rehypothecation diagram on the right (RehypoShowcase).     */
/* ------------------------------------------------------------------ */

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <header className="shrink-0 border-b-[0.5px] border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-5 py-3 sm:px-8">
          <Logo size="lg" />
          <SignInWithGoogle variant="nav" />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1180px] flex-1 items-center px-5 py-12 sm:px-8 lg:py-0">
        <div className="grid w-full grid-cols-1 items-center gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:gap-16">
          {/* ── pitch ─────────────────────────────────────────── */}
          <div>
            <span className="eyebrow">Sui · institutional OTC</span>
            <h1 className="mt-5 text-[40px] font-semibold leading-[1.13] tracking-[-0.03em] sm:text-[54px]">
              The only platform you need for OTC derivatives.
            </h1>
            <p className="mt-6 text-[22px] font-semibold leading-[1.2] tracking-[-0.015em] text-ink-soft sm:text-[27px]">
              Unparalleled collateral efficiency.
            </p>
            <div className="mt-10">
              <LandingActions />
            </div>
          </div>

          {/* ── feature wall + venues ⇄ animated flow diagram ── */}
          <RehypoShowcase />
        </div>
      </main>

      <footer className="shrink-0 border-t-[0.5px] border-line">
        <div className="mx-auto flex w-full max-w-[1180px] items-center justify-between px-5 py-3 text-[12px] text-muted sm:px-8">
          <span>© {new Date().getFullYear()} Fullmetal · Sui testnet demo</span>
          <span className="hidden font-mono tracking-[0.04em] sm:inline">Smart collateral, on Sui</span>
        </div>
      </footer>
    </div>
  );
}
