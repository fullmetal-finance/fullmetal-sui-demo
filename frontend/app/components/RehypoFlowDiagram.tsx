"use client";

/* Risk-responsive rehypothecation — the whole loop on one synced ~9s timeline,
   built STEP BY STEP (each stage fades in on its beat and stays, so the story
   assembles itself; the loop flushes at the end and rebuilds):

     step 1 · two institutions strike a bilateral OTC contract   (only they show)
     step 2 · both post reserved collateral into one pool
     step 3 · idle collateral routes to the venues each desk chose
     step 4 · yield flows back to each institution
     step 5 · volatility spikes → collateral is recalled on-chain
     coda   · markets calm → collateral is redeposited

   Every animated dot's `offset-path` is interpolated from the same `P` string
   its visible connector uses, so a dot can never drift off its line. */

const GREEN = "#1a6042";
const RED = "#b4341f";

const P = {
  otc: "M68,154 L68,224", // A ↔ B bilateral link
  a2e: "M120,129 L170,169",
  b2e: "M120,249 L170,215",
  e2v1: "M282,166 L326,100",
  e2v2: "M282,192 L326,192",
  e2v3: "M282,218 L326,284",
  yield: "M366,72 C348,28 130,24 66,102",
  r1: "M326,106 C300,122 292,150 282,169",
  r3: "M326,278 C298,264 292,230 282,215",
  vol: "M26,360 L58,357 L92,361 L128,358 L164,361 L192,355 L206,349 L216,338 L224,328 L238,378 L262,367 L300,360 L356,357 L426,360",
};

const CAPTIONS = [
  "Two institutions strike a bilateral OTC contract",
  "Both post reserved collateral into one shared pool",
  "Idle collateral routes to the venues each desk chooses",
  "Yield flows back to each institution",
  "Volatility detected — collateral recalled on-chain",
  "Markets calm — collateral redeposited",
];

const css = `
.rfd-svg text { font-family: var(--font-mono, ui-monospace, monospace); }
.rfd-dot { filter: drop-shadow(0 0 3px currentColor); }

/* ── STEP reveals: each stage fades in on its beat, holds, flushes at loop end ── */
@keyframes rfd-s0 { 0%{opacity:0} 4%{opacity:1} 96%{opacity:1} 100%{opacity:0} }
@keyframes rfd-s1 { 0%,16%{opacity:0} 20%{opacity:1} 96%{opacity:1} 100%{opacity:0} }
@keyframes rfd-s2 { 0%,33%{opacity:0} 37%{opacity:1} 96%{opacity:1} 100%{opacity:0} }
@keyframes rfd-s3 { 0%,49%{opacity:0} 53%{opacity:1} 96%{opacity:1} 100%{opacity:0} }
@keyframes rfd-s4 { 0%,63%{opacity:0} 67%{opacity:1} 96%{opacity:1} 100%{opacity:0} }
.rfd-s0{animation:rfd-s0 9s ease-in-out infinite}
.rfd-s1{animation:rfd-s1 9s ease-in-out infinite}
.rfd-s2{animation:rfd-s2 9s ease-in-out infinite}
.rfd-s3{animation:rfd-s3 9s ease-in-out infinite}
.rfd-s4{animation:rfd-s4 9s ease-in-out infinite}

/* ── dot phase timing (percent of the 9s loop) ───────────────────── */
@keyframes rfd-k1 { 0%,18%{offset-distance:0%;opacity:0} 21%{offset-distance:22%;opacity:1} 30%{offset-distance:100%;opacity:1} 33%,100%{offset-distance:100%;opacity:0} }
@keyframes rfd-k2 { 0%,34%{offset-distance:0%;opacity:0} 37%{offset-distance:22%;opacity:1} 46%{offset-distance:100%;opacity:1} 49%,100%{offset-distance:100%;opacity:0} }
@keyframes rfd-k2b { 0%,37%{offset-distance:0%;opacity:0} 40%{offset-distance:20%;opacity:.75} 47%{offset-distance:100%;opacity:.75} 50%,100%{offset-distance:100%;opacity:0} }
@keyframes rfd-k3 { 0%,50%{offset-distance:0%;opacity:0} 53%{offset-distance:20%;opacity:1} 61%{offset-distance:100%;opacity:1} 64%,100%{offset-distance:100%;opacity:0} }
@keyframes rfd-k3b { 0%,53%{offset-distance:0%;opacity:0} 56%{offset-distance:18%;opacity:.7} 62%{offset-distance:100%;opacity:.7} 65%,100%{offset-distance:100%;opacity:0} }
@keyframes rfd-k4 { 0%,72%{offset-distance:0%;opacity:0} 75%{offset-distance:22%;opacity:1} 85%{offset-distance:100%;opacity:1} 88%,100%{offset-distance:100%;opacity:0} }
@keyframes rfd-k5 { 0%,87%{offset-distance:0%;opacity:0} 89%{offset-distance:22%;opacity:1} 94%{offset-distance:100%;opacity:1} 97%,100%{offset-distance:100%;opacity:0} }

.rfd-a2e{offset-path:path("${P.a2e}")} .rfd-b2e{offset-path:path("${P.b2e}")}
.rfd-e2v1{offset-path:path("${P.e2v1}")} .rfd-e2v2{offset-path:path("${P.e2v2}")} .rfd-e2v3{offset-path:path("${P.e2v3}")}
.rfd-yield{offset-path:path("${P.yield}")}
.rfd-r1{offset-path:path("${P.r1}")} .rfd-r3{offset-path:path("${P.r3}")}
.rfd-k1{animation:rfd-k1 9s linear infinite} .rfd-k2{animation:rfd-k2 9s linear infinite}
.rfd-k2b{animation:rfd-k2b 9s linear infinite} .rfd-k3{animation:rfd-k3 9s linear infinite}
.rfd-k3b{animation:rfd-k3b 9s linear infinite} .rfd-k4{animation:rfd-k4 9s linear infinite}
.rfd-k5{animation:rfd-k5 9s linear infinite}

/* bilateral OTC beat: the A↔B link draws + the pill pops in */
@keyframes rfd-otcdraw { 0%,2%{stroke-dashoffset:100;opacity:0} 6%{opacity:1} 15%{stroke-dashoffset:0;opacity:1} 96%{opacity:.6} 100%{opacity:0} }
.rfd-otcline{stroke-dasharray:100 100;animation:rfd-otcdraw 9s ease-out infinite}
@keyframes rfd-otcpop { 0%,2%{opacity:0;transform:scale(.55)} 10%{opacity:1;transform:scale(1)} 96%{opacity:1;transform:scale(1)} 100%{opacity:0;transform:scale(1)} }
.rfd-otcpill{transform-box:fill-box;transform-origin:center;animation:rfd-otcpop 9s ease-out infinite}

/* venues dim while collateral is out (the recall beat) */
@keyframes rfd-venuedim { 0%,70%{opacity:1} 78%{opacity:.42} 86%{opacity:.42} 92%,100%{opacity:1} }
.rfd-venue{animation:rfd-venuedim 9s ease-in-out infinite}

/* reserved-collateral halo: green while routing/earning, red on recall */
@keyframes rfd-halogreen { 0%,17%{opacity:0} 24%{opacity:.5} 62%{opacity:.5} 70%{opacity:0} 87%{opacity:0} 92%{opacity:.5} 100%{opacity:0} }
@keyframes rfd-halored { 0%,70%{opacity:0} 76%{opacity:.55} 86%{opacity:.55} 90%,100%{opacity:0} }
.rfd-halogreen{animation:rfd-halogreen 9s ease-in-out infinite}
.rfd-halored{animation:rfd-halored 9s ease-in-out infinite}

/* institution receive-glow (posting + yield-in) */
@keyframes rfd-instglow { 0%,16%{opacity:0} 22%{opacity:.5} 32%{opacity:0} 50%{opacity:0} 57%{opacity:.5} 65%{opacity:0} 100%{opacity:0} }
.rfd-instglow{animation:rfd-instglow 9s ease-in-out infinite}

/* ── volatility chart (appears at step 4, draws, crashes at step 5) ── */
@keyframes rfd-voldraw { 0%,50%{stroke-dashoffset:100} 92%{stroke-dashoffset:0} 100%{stroke-dashoffset:0} }
.rfd-volline{stroke-dasharray:100 100;animation:rfd-voldraw 9s linear infinite}
.rfd-voltip{offset-path:path("${P.vol}");animation:rfd-voltip 9s linear infinite}
@keyframes rfd-voltip { 0%,50%{offset-distance:0%;opacity:0} 53%{opacity:1} 92%{offset-distance:100%;opacity:1} 95%,100%{opacity:0} }
@keyframes rfd-voltipfill { 0%,68%{fill:${GREEN}} 72%{fill:${RED}} 88%{fill:${RED}} 92%,100%{fill:${GREEN}} }
.rfd-voltipfill{animation:rfd-voltipfill 9s step-end infinite}
@keyframes rfd-crashflash { 0%,68%{opacity:0} 73%{opacity:.12} 88%{opacity:.12} 92%,100%{opacity:0} }
.rfd-crashflash{animation:rfd-crashflash 9s ease-in-out infinite}
@keyframes rfd-crashtag { 0%,70%{opacity:0} 74%{opacity:1} 88%{opacity:1} 92%,100%{opacity:0} }
.rfd-crashtag{animation:rfd-crashtag 9s ease-in-out infinite}

/* annotation emphasis pulses */
@keyframes rfd-recalltag { 0%,68%{opacity:.3} 74%{opacity:1} 88%{opacity:1} 92%,100%{opacity:.3} }
.rfd-recalltag{animation:rfd-recalltag 9s ease-in-out infinite}

/* ── caption narrator ───────────────────────────────────────────── */
.rfd-cap{animation-duration:9s;animation-timing-function:ease-in-out;animation-iteration-count:infinite}
@keyframes rfd-cap0 { 0%{opacity:0} 4%{opacity:1} 16%{opacity:1} 20%,100%{opacity:0} }
@keyframes rfd-cap1 { 0%,18%{opacity:0} 22%{opacity:1} 32%{opacity:1} 36%,100%{opacity:0} }
@keyframes rfd-cap2 { 0%,34%{opacity:0} 38%{opacity:1} 48%{opacity:1} 52%,100%{opacity:0} }
@keyframes rfd-cap3 { 0%,50%{opacity:0} 54%{opacity:1} 63%{opacity:1} 67%,100%{opacity:0} }
@keyframes rfd-cap4 { 0%,68%{opacity:0} 73%{opacity:1} 86%{opacity:1} 90%,100%{opacity:0} }
@keyframes rfd-cap5 { 0%,88%{opacity:0} 91%{opacity:1} 97%{opacity:1} 99%,100%{opacity:0} }

@media (prefers-reduced-motion: reduce) {
  .rfd-dot,.rfd-voltip { opacity: 0 !important; animation: none !important; }
  .rfd-s0,.rfd-s1,.rfd-s2,.rfd-s3,.rfd-s4,.rfd-venue,.rfd-volline,.rfd-cap,
  .rfd-halogreen,.rfd-halored,.rfd-instglow,.rfd-crashflash,.rfd-crashtag,
  .rfd-recalltag,.rfd-otcline,.rfd-otcpill { animation: none !important; }
  .rfd-s0,.rfd-s1,.rfd-s2,.rfd-s3,.rfd-s4 { opacity: 1; }
  .rfd-volline { stroke-dashoffset: 0; } .rfd-otcline { stroke-dashoffset: 0; opacity: .55; }
  .rfd-otcpill { opacity: 1; } .rfd-cap0 { opacity: 1 !important; }
}
`;

function Box({
  x, y, w, h, dark, title, sub,
}: { x: number; y: number; w: number; h: number; dark?: boolean; title: string; sub?: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="7"
        fill={dark ? "var(--ink)" : "var(--surface)"}
        stroke={dark ? "var(--ink)" : "var(--line-strong)"} strokeWidth="1.4" />
      <text x={x + w / 2} y={sub ? y + h / 2 - 4 : y + h / 2 + 4} textAnchor="middle"
        fontSize="12.5" fontWeight="700" letterSpacing="0.03em"
        fill={dark ? "var(--bg)" : "var(--ink)"}>{title}</text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 11} textAnchor="middle" fontSize="8.6" fontWeight="600"
          fill={dark ? "rgba(255,255,255,0.72)" : "var(--muted)"}>{sub}</text>
      )}
    </g>
  );
}

export default function RehypoFlowDiagram() {
  const dot = (cls: string, color: string) => (
    <circle className={`rfd-dot ${cls}`} r="3.8" cx="0" cy="0" fill={color} style={{ color }} />
  );
  return (
    <div className="flex h-full flex-col">
      <style>{css}</style>
      <p className="mb-1 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] text-ink-soft">
        Risk-responsive rehypothecation
      </p>

      <svg viewBox="0 0 452 408" className="rfd-svg w-full flex-1" preserveAspectRatio="xMidYMid meet" role="img"
        aria-label="Animated diagram that assembles step by step: two institutions strike a bilateral OTC, post reserved collateral to a shared pool, which routes to yield venues; yield returns to the institutions, then volatility triggers an on-chain recall and redeposit.">

        {/* halos (behind everything) */}
        <rect className="rfd-halogreen" x="158" y="134" width="136" height="116" rx="12" fill={GREEN} opacity="0" />
        <rect className="rfd-halored" x="158" y="134" width="136" height="116" rx="12" fill={RED} opacity="0" />
        <rect className="rfd-instglow" x="10" y="98" width="116" height="62" rx="10" fill={GREEN} opacity="0" />
        <rect className="rfd-instglow" x="10" y="218" width="116" height="62" rx="10" fill={GREEN} opacity="0" />

        {/* ── STEP 1 · the two institutions + bilateral OTC ── */}
        <g className="rfd-s0">
          <Box x={16} y={104} w={110} h={50} title="INSTITUTION A" />
          <Box x={16} y={224} w={110} h={50} title="INSTITUTION B" />
          <path className="rfd-otcline" d={P.otc} pathLength={100} fill="none" stroke="var(--ink-soft)" strokeWidth="1.5" strokeDasharray="100 100" strokeLinecap="round" opacity="0" />
          <g className="rfd-otcpill">
            <rect x="30" y="178" width="76" height="22" rx="11" fill="var(--bg)" stroke="var(--ink-soft)" strokeWidth="1.2" />
            <text x="68" y="192.5" textAnchor="middle" fontSize="8.8" fontWeight="700" letterSpacing="0.03em" fill="var(--ink)">BILATERAL OTC</text>
          </g>
        </g>

        {/* ── STEP 2 · reserved collateral pool + post connectors ── */}
        <g className="rfd-s1">
          <path d={P.a2e} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
          <path d={P.b2e} fill="none" stroke="var(--line-strong)" strokeWidth="1.5" strokeLinecap="round" opacity="0.5" />
          <Box x={170} y={144} w={112} h={96} dark title="RESERVED" sub="cross-margin" />
          <text x="226" y="176" textAnchor="middle" fontSize="12.5" fontWeight="700" letterSpacing="0.03em" fill="var(--bg)">COLLATERAL</text>
          <text x="226" y="224" textAnchor="middle" fontSize="8.6" fontWeight="600" fill="rgba(255,255,255,0.72)">non-custodial pool</text>
        </g>

        {/* ── STEP 3 · rehypothecation venues + route connectors ── */}
        <g className="rfd-s2">
          <path d={P.e2v1} fill="none" stroke={GREEN} strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
          <path d={P.e2v2} fill="none" stroke={GREEN} strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
          <path d={P.e2v3} fill="none" stroke={GREEN} strokeWidth="1.6" strokeLinecap="round" opacity="0.5" />
          {[
            { y: 78, label: "Lending Markets" },
            { y: 170, label: "Liquidity Pools" },
            { y: 262, label: "Yield Vaults" },
          ].map((v) => (
            <g key={v.label} className="rfd-venue">
              <rect x="326" y={v.y} width="112" height="44" rx="7" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="1.4" />
              <rect x="326" y={v.y} width="112" height="3.5" rx="1.75" fill={GREEN} />
              <text x="382" y={v.y + 27} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--ink)">{v.label}</text>
            </g>
          ))}
          <text x="298" y="68" textAnchor="middle" fontSize="9" fontWeight="700" letterSpacing="0.05em" fill={GREEN}>ROUTED TO VENUES</text>
        </g>

        {/* ── STEP 4 · yield returns + the market it earns against ── */}
        <g className="rfd-s3">
          <path d={P.yield} fill="none" stroke={GREEN} strokeWidth="1.5" strokeDasharray="5 4" strokeLinecap="round" opacity="0.55" />
          <text x="212" y="16" textAnchor="middle" fontSize="10.5" fontWeight="700" fill={GREEN}>yield returns to each institution</text>
          {/* volatility chart */}
          <rect className="rfd-crashflash" x="20" y="322" width="416" height="72" rx="8" fill={RED} opacity="0" />
          <line x1="26" y1="392" x2="426" y2="392" stroke="var(--line)" strokeWidth="1" />
          <text x="26" y="348" fontSize="8.6" fontWeight="700" letterSpacing="0.08em" fill="var(--muted)">VOLATILITY · SPCX MARK</text>
          <path className="rfd-volline" d={P.vol} pathLength={100} fill="none" stroke="var(--ink)" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
          <circle className="rfd-dot rfd-voltip rfd-voltipfill" r="3.4" cx="0" cy="0" fill={GREEN} style={{ color: RED }} />
          <text className="rfd-crashtag" x="238" y="406" textAnchor="middle" fontSize="9" fontWeight="700" fill={RED}>▼ CRASH</text>
        </g>

        {/* ── STEP 5 · risk-responsive recall ── */}
        <g className="rfd-s4">
          <path d={P.r1} fill="none" stroke={RED} strokeWidth="1.4" strokeDasharray="3 4" strokeLinecap="round" className="rfd-recalltag" />
          <path d={P.r3} fill="none" stroke={RED} strokeWidth="1.4" strokeDasharray="3 4" strokeLinecap="round" className="rfd-recalltag" />
          <text className="rfd-recalltag" x="212" y="322" textAnchor="middle" fontSize="10.5" fontWeight="700" letterSpacing="0.03em" fill={RED}>RISK-RESPONSIVE RECALL</text>
        </g>

        {/* travelling dots (only visible during their own beat) */}
        {dot("rfd-a2e rfd-k1", GREEN)}
        {dot("rfd-b2e rfd-k1", GREEN)}
        {dot("rfd-e2v1 rfd-k2", GREEN)}
        {dot("rfd-e2v2 rfd-k2", GREEN)}
        {dot("rfd-e2v3 rfd-k2", GREEN)}
        {dot("rfd-e2v2 rfd-k2b", GREEN)}
        {dot("rfd-yield rfd-k3", GREEN)}
        {dot("rfd-yield rfd-k3b", GREEN)}
        {dot("rfd-r1 rfd-k4", RED)}
        {dot("rfd-r3 rfd-k4", RED)}
        {dot("rfd-e2v1 rfd-k5", GREEN)}
        {dot("rfd-e2v2 rfd-k5", GREEN)}
        {dot("rfd-e2v3 rfd-k5", GREEN)}
      </svg>

      {/* narrator — one bold line per beat, cross-fading on the same 9s clock */}
      <div className="relative mt-1 h-[32px]">
        {CAPTIONS.map((c, i) => (
          <p key={i}
            className={`rfd-cap rfd-cap${i} absolute inset-0 flex items-center justify-center text-center text-[13px] font-semibold leading-tight`}
            style={{ animationName: `rfd-cap${i}`, opacity: 0, color: i === 4 ? RED : i === 3 ? GREEN : "var(--ink)" }}>
            {c}
          </p>
        ))}
      </div>
    </div>
  );
}
