"use client";

import { useState } from "react";

import { usd } from "@/lib/fullmetal";
import { positionPnl, type MockPosition, type MockTrader } from "@/lib/mock";

/* A management pop-up for a clicked blotter position or trader. The controls are
   mocked for the demo (no on-chain effect) — they exist to show the desk-admin
   surface: closing positions, adjusting trader caps, revoking permissions. */
export type ManageSubject =
  | { kind: "position"; position: MockPosition }
  | { kind: "trader"; trader: MockTrader };

export default function ManageModal({
  subject,
  onClose,
}: {
  subject: ManageSubject | null;
  onClose: () => void;
}) {
  if (!subject) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-12"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[440px] rounded-[18px] border border-line-strong bg-surface p-7"
        onClick={(e) => e.stopPropagation()}
      >
        {subject.kind === "position" ? (
          <PositionBody p={subject.position} onClose={onClose} />
        ) : (
          <TraderBody t={subject.trader} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function PositionBody({ p, onClose }: { p: MockPosition; onClose: () => void }) {
  const pnl = positionPnl(p);
  const up = pnl >= 0;
  const [acted, setActed] = useState<string | null>(null);
  return (
    <>
      <Header
        eyebrow="Position · manage"
        title={
          <>
            {p.asset}{" "}
            <span className={p.side === "long" ? "text-[#1a6042]" : "text-[#9a2c1a]"}>
              {p.side.toUpperCase()}
            </span>
          </>
        }
        sub={`vs ${p.cpty}`}
        onClose={onClose}
      />
      <div className="mt-5 divide-y divide-line border-y border-line">
        <Detail label="Notional" value={usd(p.notional, { maximumFractionDigits: 0 })} />
        <Detail label="Entry" value={usd(p.entry)} />
        <Detail label="Mark" value={usd(p.mark)} />
        <Detail
          label="Unrealized PnL"
          value={`${up ? "+" : "−"}${usd(Math.abs(pnl), { maximumFractionDigits: 0 })}`}
          accent={up ? "up" : "down"}
        />
        <Detail label="Initial margin" value={usd(p.im, { maximumFractionDigits: 0 })} />
        <Detail label="Rehypothecated to" value={p.venue} />
        <Detail label="Tenor" value={/perp/i.test(p.maturity) ? "∞ Perp" : p.maturity} />
      </div>
      {acted ? (
        <Acted label={acted} />
      ) : (
        <div className="mt-5 space-y-2.5">
          <button onClick={() => setActed("Margin top-up")} className={btnSecondary}>Add margin</button>
          <button onClick={() => setActed("Position close")} className={btnPrimary}>Close position</button>
        </div>
      )}
      <Footnote />
    </>
  );
}

function TraderBody({ t, onClose }: { t: MockTrader; onClose: () => void }) {
  const util = t.book > 0 ? t.used / t.book : 0;
  const [acted, setActed] = useState<string | null>(null);
  return (
    <>
      <Header eyebrow="Trader · manage" title={t.name} sub={`${t.address} · ${t.role}`} onClose={onClose} />
      <div className="mt-5 divide-y divide-line border-y border-line">
        <Detail label="Desk cap · book size" value={usd(t.book, { maximumFractionDigits: 0 })} />
        <Detail label="Deployed" value={usd(t.used, { maximumFractionDigits: 0 })} />
        <Detail label="Utilization" value={`${Math.round(util * 100)}%`} />
        <Detail label="Status" value="Active" accent="up" />
      </div>
      {acted ? (
        <Acted label={acted} />
      ) : (
        <div className="mt-5 space-y-2.5">
          <button onClick={() => setActed("Desk-cap change")} className={btnSecondary}>Modify trader desk cap</button>
          <button onClick={() => setActed("Permissions revoke")} className={btnDanger}>Revoke trading permissions</button>
        </div>
      )}
      <Footnote />
    </>
  );
}

function Header({
  eyebrow,
  title,
  sub,
  onClose,
}: {
  eyebrow: string;
  title: React.ReactNode;
  sub?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex items-start justify-between">
      <div>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{eyebrow}</p>
        <h2 className="mt-1.5 text-[19px] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {sub && <p className="mt-0.5 font-mono text-[12px] text-muted">{sub}</p>}
      </div>
      <button onClick={onClose} className="text-[20px] leading-none text-muted hover:text-ink">×</button>
    </div>
  );
}

function Detail({
  label,
  value,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  accent?: "up" | "down";
}) {
  return (
    <div className="flex items-center justify-between py-2.5 text-[13px]">
      <span className="text-muted">{label}</span>
      <span
        className={`font-mono ${accent === "up" ? "text-[#1a6042]" : accent === "down" ? "text-[#9a2c1a]" : "text-ink"}`}
      >
        {value}
      </span>
    </div>
  );
}

function Acted({ label }: { label: string }) {
  return (
    <p className="mt-5 rounded-[8px] border border-line bg-bg px-3 py-2.5 text-center text-[12px] text-muted">
      {label} queued — demo only, no on-chain effect.
    </p>
  );
}

function Footnote() {
  return <p className="mt-3 text-center text-[11px] text-faint">Mock desk controls for the demo.</p>;
}

const btnPrimary =
  "flex w-full items-center justify-center rounded-[9px] border border-line-strong bg-ink px-4 py-3 text-[14px] font-semibold text-bg transition-opacity hover:opacity-90";
const btnSecondary =
  "flex w-full items-center justify-center rounded-[9px] border border-line-strong bg-surface px-4 py-3 text-[14px] font-medium text-ink transition-colors hover:bg-bg";
const btnDanger =
  "flex w-full items-center justify-center rounded-[9px] border border-[#b4341f]/40 px-4 py-3 text-[14px] font-medium text-[#b4341f] transition-colors hover:bg-[#b4341f]/10";
