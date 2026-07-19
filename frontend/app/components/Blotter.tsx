"use client";

import { useState } from "react";

import { explorer, usd } from "@/lib/fullmetal";
import { MOCK_POSITIONS, positionPnl, type MockPosition } from "@/lib/mock";
import ManageModal from "./ManageModal";

export default function Blotter({ real = [], onRefresh }: { real?: MockPosition[]; onRefresh?: () => void }) {
  const rows = [...real, ...MOCK_POSITIONS];
  const [selected, setSelected] = useState<MockPosition | null>(null);
  return (
    <>
      <section className="rounded-[14px] border border-line-strong bg-surface">
        <div className="flex items-center justify-between border-b border-line-strong px-6 py-4">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Open positions</h2>
          <span className="font-mono text-[12px] text-muted">{rows.length} open · cross-margined</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-line-strong text-left font-mono text-[11px] uppercase tracking-[0.1em] text-ink-soft">
                <Th>Asset</Th>
                <Th>Side</Th>
                <Th>Trader</Th>
                <Th>Counterparty</Th>
                <Th right>Notional</Th>
                <Th right title="the forward price you agreed at (entry)">Entry</Th>
                <Th right title="the current market price (mark-to-market)">Mark</Th>
                <Th right>uPnL</Th>
                <Th right>IM</Th>
                <Th>Venue</Th>
                <Th right>Tenor</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => (
                <Row key={p.otcId ?? i} p={p} onSelect={() => setSelected(p)} />
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ManageModal
        subject={selected ? { kind: "position", position: selected } : null}
        onClose={() => setSelected(null)}
        onRefresh={onRefresh}
      />
    </>
  );
}

function Row({ p, onSelect }: { p: MockPosition; onSelect: () => void }) {
  const pnl = positionPnl(p);
  const up = pnl >= 0;
  return (
    <tr
      onClick={onSelect}
      className="cursor-pointer border-b border-line text-ink odd:bg-bg/40 transition-colors last:border-b-0 hover:bg-[rgba(0,0,0,0.06)]"
    >
      <Td>
        <span className="font-semibold">{p.asset}</span>
        {p.otcId && (
          <a
            href={explorer.object(p.otcId)}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="ml-1.5 text-[11px] text-muted hover:text-ink"
          >
            ↗
          </a>
        )}
      </Td>
      <Td>
        <span className={`rounded-[5px] px-2 py-0.5 text-[11px] font-semibold ${p.side === "long" ? "bg-[#1f6f4d]/12 text-[#1a6042]" : "bg-[#b4341f]/12 text-[#9a2c1a]"}`}>
          {p.side.toUpperCase()}
        </span>
      </Td>
      <Td><span className={/^0x/.test(p.trader) ? "font-mono text-[12px]" : ""}>{p.trader}</span></Td>
      <Td>{p.cpty}</Td>
      <Td right mono>{usd(p.notional, { maximumFractionDigits: 0 })}</Td>
      <Td right mono>{usd(p.entry)}</Td>
      <Td right mono>{usd(p.mark)}</Td>
      <Td right mono>
        <span className={up ? "text-[#1a6042]" : "text-[#9a2c1a]"}>
          {up ? "+" : "−"}{usd(Math.abs(pnl), { maximumFractionDigits: 0 })}
        </span>
      </Td>
      <Td right mono>{usd(p.im, { maximumFractionDigits: 0 })}</Td>
      <Td><span className="font-mono text-[12px] text-muted">{p.venue}</span></Td>
      <Td right mono>
        {/perp/i.test(p.maturity) ? (
          <span title="Perpetual — no expiry">∞ Perp</span>
        ) : (
          p.maturity
        )}
      </Td>
    </tr>
  );
}

function Th({ children, right, title }: { children: React.ReactNode; right?: boolean; title?: string }) {
  return <th title={title} className={`px-4 py-2.5 font-medium ${right ? "text-right" : ""}`}>{children}</th>;
}
function Td({ children, right, mono }: { children: React.ReactNode; right?: boolean; mono?: boolean }) {
  return <td className={`px-4 py-3 ${right ? "text-right" : ""} ${mono ? "font-mono" : ""}`}>{children}</td>;
}
