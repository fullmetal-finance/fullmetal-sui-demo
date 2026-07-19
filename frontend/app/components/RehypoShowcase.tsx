"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import RehypoFlowDiagram from "./RehypoFlowDiagram";

/* The landing hero's right panel — a MANUAL two-slide carousel:
     0 · the feature / venue card
     1 · the animated risk-responsive-rehypothecation diagram
   Grey dots + prev/next arrows switch between them (no auto-advance — the
   animation only shows when the viewer navigates to it). */

const SLIDES = ["Overview", "How it works"];

const FEATURES = [
  { title: "One-click risk-responsive rehypothecation", tag: "routed to yield, recalled on risk", icon: IconCycle },
  { title: "Collateral is the new yield primitive", tag: "no more idle margin", icon: IconYield },
  { title: "Cross-margined forwards, perps & hybrids", tag: "higher risk-adjusted leverage", icon: IconLayers },
  { title: "Easy contract creation & treasury management", tag: "one protocol, one click, zero administrative hassle", icon: IconDoc },
];

const VENUES = [
  { name: "DeepBook", src: "/logos/deepbook.png", live: true },
  { name: "Suilend", src: "/logos/suilend.png", live: true },
  { name: "Navi", src: "/logos/navi.png", live: true },
];

export default function RehypoShowcase() {
  const [slide, setSlide] = useState(0);
  // bump on every entry to the diagram slide so React remounts it → the CSS
  // animation always restarts from the first beat instead of resuming midway
  const [epoch, setEpoch] = useState(0);
  const go = (d: number) => setSlide((s) => (s + d + SLIDES.length) % SLIDES.length);

  useEffect(() => {
    if (slide === 1) setEpoch((e) => e + 1);
  }, [slide]);

  // ← / → keys flip the carousel (ignored while typing in a field)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="rounded-[18px] border-[0.5px] border-line bg-surface p-6 sm:p-7">
      <div className="grid min-h-[452px]">
        {/* slide 0 · info */}
        <div
          className={`[grid-area:1/1] transition-opacity duration-500 ease-in-out ${slide === 0 ? "opacity-100" : "pointer-events-none opacity-0"}`}
          aria-hidden={slide !== 0}
        >
          <ul className="flex flex-col">
            {FEATURES.map(({ title, tag, icon: Icon }, i) => (
              <li key={title} className={`flex items-center gap-4 py-3.5 ${i > 0 ? "border-t-[0.5px] border-line" : ""}`}>
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] border-[0.5px] border-line-strong text-ink">
                  <Icon />
                </span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">{title}</span>
                  <span className="mt-0.5 block text-[13px] text-muted">{tag}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-5 border-t-[0.5px] border-line pt-5">
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted">Rehypothecation venues</p>
            <div className="mt-3 grid grid-cols-3 gap-3">
              {VENUES.map((v) => (
                <div key={v.name} className={`flex flex-col items-center gap-2 rounded-[12px] border-[0.5px] border-line bg-bg px-2 py-3 ${v.live ? "" : "opacity-70"}`}>
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

        {/* slide 1 · diagram (always mounted so the animation stays in sync) */}
        <div
          className={`[grid-area:1/1] transition-opacity duration-500 ease-in-out ${slide === 1 ? "opacity-100" : "pointer-events-none opacity-0"}`}
          aria-hidden={slide !== 1}
        >
          <RehypoFlowDiagram key={epoch} />
        </div>
      </div>

      {/* ── carousel controls: ‹  • •  › ── */}
      <div className="mt-4 flex items-center justify-center gap-4 border-t-[0.5px] border-line pt-4">
        <Arrow dir="prev" onClick={() => go(-1)} />
        <div className="flex items-center gap-2">
          {SLIDES.map((label, i) => (
            <button
              key={label}
              onClick={() => setSlide(i)}
              aria-label={label}
              aria-current={slide === i}
              className={`rounded-full transition-all ${slide === i ? "h-[8px] w-[8px] bg-ink" : "h-[7px] w-[7px] bg-line-strong hover:bg-muted"}`}
            />
          ))}
        </div>
        <Arrow dir="next" onClick={() => go(1)} />
      </div>
    </div>
  );
}

function Arrow({ dir, onClick }: { dir: "prev" | "next"; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label={dir === "prev" ? "Previous" : "Next"}
      className="flex h-7 w-7 items-center justify-center rounded-full border-[0.5px] border-line text-muted transition-colors hover:border-line-strong hover:text-ink"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        {dir === "prev" ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
  );
}

/* ── line icons ── */
function IconCycle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 21v-5h5" />
    </svg>
  );
}
function IconYield() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 17 9 11 13 15 21 7" /><polyline points="15 7 21 7 21 13" />
    </svg>
  );
}
function IconLayers() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polygon points="12 3 21 8 12 13 3 8" /><polyline points="3 12.5 12 17.5 21 12.5" /><polyline points="3 16.5 12 21.5 21 16.5" />
    </svg>
  );
}
function IconDoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /><path d="M9 13.5h6" /><path d="M9 17h4" />
    </svg>
  );
}
