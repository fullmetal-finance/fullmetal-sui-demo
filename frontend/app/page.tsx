import Logo from "./components/Logo";
import Footer from "./components/Footer";
import LandingActions from "./components/LandingActions";
import SignInWithGoogle from "./components/SignInWithGoogle";

export default function Home() {
  return (
    <div>
      {/* full-bleed surface header — matches the logo background */}
      <header className="w-full border-b-[0.5px] border-line bg-surface">
        <div className="mx-auto flex w-full max-w-[1120px] items-center justify-between px-4 py-3 sm:px-6">
          <Logo size="lg" />
          <SignInWithGoogle variant="nav" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
        <section className="flex min-h-[68vh] flex-col items-start justify-center py-20">
          <span className="eyebrow">Sui testnet · institutional OTC</span>
          <h1 className="mt-6 max-w-[760px] text-4xl leading-[1.14] tracking-[-0.01em] sm:text-5xl">
            Institutional OTC derivatives with risk-responsive collateral
            rehypothecation.
          </h1>
          <p className="mt-6 max-w-[560px] text-[15px] leading-[1.9] text-ink-soft">
            Posted margin shouldn&apos;t sit idle. Fullmetal routes it into
            DeepBook&apos;s margin pool to earn lending yield — and pulls it back
            the moment risk triggers fire.
          </p>

          <div className="mt-10">
            <LandingActions />
          </div>

          <p className="mt-6 font-mono text-[12px] text-muted">
            Sign in with Google · settlement in USDC · gas sponsored
          </p>
        </section>
      </main>

      <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
        <Footer />
      </div>
    </div>
  );
}
