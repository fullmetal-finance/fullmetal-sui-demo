import Nav from "./components/Nav";
import Footer from "./components/Footer";

/* Landing page — placeholder content until the demo flow is decided. */
export default function Home() {
  return (
    <>
      <main className="mx-auto w-full max-w-[1120px] px-4 pt-4 sm:px-6">
        <Nav />

        <section className="flex min-h-[60vh] flex-col items-start justify-center px-6 py-24 sm:px-8">
          <span className="eyebrow">Sui testnet · demo</span>
          <h1 className="mt-6 max-w-[720px] text-4xl leading-[1.15] tracking-[-0.01em] sm:text-5xl">
            Institutional OTC derivatives with risk-responsive collateral
            rehypothecation.
          </h1>
          <p className="mt-6 max-w-[560px] text-[15px] leading-[1.9] text-ink-soft">
            Posted margin shouldn&apos;t sit idle. Fullmetal routes it into
            DeepBook&apos;s margin pool to earn lending yield — and pulls it
            back the moment risk triggers fire.
          </p>
          <p className="mt-10 font-mono text-[12px] uppercase tracking-[0.18em] text-muted">
            Demo under construction
          </p>
        </section>
      </main>
      <div className="mx-auto w-full max-w-[1120px] px-4 sm:px-6">
        <Footer />
      </div>
    </>
  );
}
