import Image from "next/image";
import Logo from "./components/Logo";
import LandingActions from "./components/LandingActions";
import SignInWithGoogle from "./components/SignInWithGoogle";

/* ------------------------------------------------------------------ */
/*  Landing page — locked to a single viewport (no scroll) for the      */
/*  demo recording. Two-column hero: the pitch + CTAs on the left, the   */
/*  feature wall + live rehypothecation venues on the right. Static.     */
/* ------------------------------------------------------------------ */

const FEATURES = [
  { title: "One-click risk-responsive rehypothecation", tag: "routed to yield, recalled on risk", icon: IconCycle },
  { title: "Collateral is the new yield primitive", tag: "no more idle margin", icon: IconYield },
  { title: "Cross-margined forwards, perps & hybrids", tag: "higher risk-adjusted leverage", icon: IconLayers },
  { title: "Easy contract creation & treasury management", tag: "one protocol, one click, zero administrative hassle", icon: IconDoc },
];

const VENUES = [
  { name: "DeepBook", src: "/logos/deepbook.png", live: true },
  { name: "Suilend", src: "/logos/suilend.png", live: false },
  { name: "Navi", src: "/logos/navi.png", live: false },
];

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

          {/* ── feature wall + venues ─────────────────────────── */}
          <div className="rounded-[18px] border-[0.5px] border-line bg-surface p-6 sm:p-7">
            <ul className="flex flex-col">
              {FEATURES.map(({ title, tag, icon: Icon }, i) => (
                <li
                  key={title}
                  className={`flex items-center gap-4 py-3.5 ${i > 0 ? "border-t-[0.5px] border-line" : ""}`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border-[0.5px] border-line-strong text-ink">
                    <Icon />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">
                      {title}
                    </span>
                    <span className="mt-0.5 block text-[13px] text-muted">{tag}</span>
                  </span>
                </li>
              ))}
            </ul>

            <div className="mt-5 border-t-[0.5px] border-line pt-5">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">
                Rehypothecation venues
              </p>
              <div className="mt-3 grid grid-cols-3 gap-3">
                {VENUES.map((v) => (
                  <div
                    key={v.name}
                    className={`flex flex-col items-center gap-2 rounded-[12px] border-[0.5px] border-line bg-bg px-2 py-3 ${v.live ? "" : "opacity-70"}`}
                  >
                    <span className="relative h-9 w-9 overflow-hidden rounded-[8px] border-[0.5px] border-line">
                      <Image src={v.src} alt={v.name} fill sizes="36px" className="object-cover" />
                    </span>
                    <span className="text-[13px] font-semibold leading-none text-ink">{v.name}</span>
                    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted">
                      <span className={`h-[5px] w-[5px] rounded-full ${v.live ? "bg-[#1f6f4d]" : "bg-muted/50"}`} />
                      {v.live ? "Live" : "Soon"}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
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

/* ── line icons (1.5 stroke, currentColor) — each chosen to read at a
      glance: a recall loop, a yield curve, stacked instruments, a contract. */
function IconCycle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}
function IconYield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 17 9 11 13 15 21 7" />
      <polyline points="15 7 21 7 21 13" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 3 21 8 12 13 3 8" />
      <polyline points="3 12.5 12 17.5 21 12.5" />
      <polyline points="3 16.5 12 21.5 21 16.5" />
    </svg>
  );
}
function IconDoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13.5h6" />
      <path d="M9 17h4" />
    </svg>
  );
}
