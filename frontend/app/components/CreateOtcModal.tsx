"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";

import {
  INTERVAL_MS,
  MAINTENANCE_PCT,
  MIN_IM_PCT,
  PROTOCOL_MIN_IM,
  SPCX,
  explorer,
  usd,
} from "@/lib/fullmetal";
import { oracleStatus } from "@/lib/oracle";
import { useCreateOtc, type OtcResult } from "@/lib/otc";
import { useRates } from "@/lib/rates";
import MarkChart from "./MarkChart";

export default function CreateOtcModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (r: OtcResult) => void;
}) {
  const createOtc = useCreateOtc();
  const rates = useRates();

  const [entry, setEntry] = useState<"direct" | "rfq">("direct");
  const [counterparty, setCounterparty] = useState("");
  const [side, setSide] = useState<"long" | "short">("long");
  const [asset, setAsset] = useState("SPCX");
  const [notional, setNotional] = useState(1);
  const [strike, setStrike] = useState<number>(SPCX.initialMark);
  const [im, setIm] = useState(5);
  const [imTouched, setImTouched] = useState(false);
  const [offerMins, setOfferMins] = useState(60);
  const [maturityDays, setMaturityDays] = useState(7);
  const [interval, setInterval] = useState<"daily" | "hourly">("daily");
  const [rehypo, setRehypo] = useState(true);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<OtcResult | null>(null);
  const [strikeTouched, setStrikeTouched] = useState(false);
  const [liveMark, setLiveMark] = useState<number | null>(null);

  // live oracle mark while the modal is open — the same feed contracts settle on
  useEffect(() => {
    if (!open || done) return;
    let alive = true;
    const read = async () => {
      try {
        const s = await oracleStatus();
        if (alive) setLiveMark(s.mark);
      } catch {
        /* transient */
      }
    };
    read();
    const t = window.setInterval(read, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [open, done]);

  // strike tracks the live mark until the user edits it
  useEffect(() => {
    if (!strikeTouched && liveMark && liveMark > 0 && asset === SPCX.symbol) {
      setStrike(Math.round(liveMark * 100) / 100);
    }
  }, [liveMark, strikeTouched, asset]);

  const notionalUsd = notional * strike;
  const minIm = Math.max(PROTOCOL_MIN_IM, notionalUsd * MIN_IM_PCT);

  // prefill IM from notional×strike until the user edits it (ceil — a rounded-
  // down prefill would sit below the 5% floor and invalidate the form)
  useEffect(() => {
    if (!imTouched) setIm(Math.max(PROTOCOL_MIN_IM, Math.ceil(notionalUsd * MIN_IM_PCT)));
  }, [notionalUsd, imTouched]);

  const leverage = im > 0 ? notionalUsd / im : 0;
  const maintenance = im * MAINTENANCE_PCT;
  const imValid = im >= minIm - 1e-9;

  const valid = useMemo(() => {
    if (notional <= 0 || im <= 0 || !asset.trim() || !imValid) return false;
    if (entry === "direct" && (!counterparty.trim() || strike <= 0)) return false;
    return true;
  }, [notional, im, asset, imValid, entry, counterparty, strike]);

  if (!open) return null;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const r = await createOtc({
        entry,
        counterparty,
        side,
        asset: asset.trim(),
        notional,
        strike,
        im,
        settlementMs: INTERVAL_MS[interval],
        contractExpiryMs: Date.now() + maturityDays * INTERVAL_MS.daily,
        offerTtlMs: offerMins * 60_000,
        rehypo,
      });
      setDone(r);
      if (r.deployWarning) {
        setError(`Offer created — but the locked IM did not auto-deploy to DeepBook (${r.deployWarning}). Deploy it from the collateral manager.`);
      }
      onCreated?.(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 px-4 py-10"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[560px] rounded-[16px] border-[0.5px] border-line-strong bg-surface p-7 sm:p-8"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-[18px] tracking-[-0.01em]">New OTC contract</h2>
          <button onClick={onClose} className="text-[18px] text-muted hover:text-ink">×</button>
        </div>

        {done ? (
          <Success done={done} onClose={onClose} />
        ) : (
          <>
            {/* Entry */}
            <Section label="Entry">
              <Segmented
                value={entry}
                onChange={(v) => setEntry(v as "direct" | "rfq")}
                options={[
                  { value: "direct", label: "Direct to counterparty" },
                  { value: "rfq", label: "Broadcast (RFQ)" },
                ]}
              />
              {entry === "direct" ? (
                <Labeled label="Counterparty" hint="org handle or institution id">
                  <input
                    className={input}
                    value={counterparty}
                    onChange={(e) => setCounterparty(e.target.value)}
                    placeholder="cumberland"
                  />
                </Labeled>
              ) : (
                <p className="mt-2 text-[12px] leading-[1.6] text-muted">
                  Broadcast to all desks; makers quote a firm price you accept.
                  The strike is set by the maker&apos;s quote.
                </p>
              )}
            </Section>

            {/* Instrument */}
            <Section label="Instrument">
              <Segmented
                value="forward"
                onChange={() => {}}
                options={[
                  { value: "forward", label: "Forward" },
                  { value: "perp", label: "Perp", disabled: "live: Forward. Perp is post-MVP." },
                  { value: "hybrid", label: "Hybrid", disabled: "Hybrid (expiry + funding + lock-in): post-MVP." },
                ]}
              />
              <Labeled label="Direction">
                <Segmented
                  value={side}
                  onChange={(v) => setSide(v as "long" | "short")}
                  options={[
                    { value: "long", label: "Long" },
                    { value: "short", label: "Short" },
                  ]}
                />
              </Labeled>
            </Section>

            {/* Economics */}
            <Section label="Economics">
              {asset === SPCX.symbol && (
                <MarkChart symbol={SPCX.symbol} label={SPCX.label} />
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Labeled label="Asset">
                  <input className={input} value={asset} onChange={(e) => setAsset(e.target.value.toUpperCase())} placeholder="SPCX" />
                </Labeled>
                <Labeled label="Notional" hint="units of underlying — fractional OK (min 0.000001)">
                  <input className={input} type="number" step="0.1" min="0" value={notional} onChange={(e) => setNotional(+e.target.value)} />
                </Labeled>
              </div>
              {entry === "direct" && (
                <Labeled label="Forward price / strike" hint="agreed settlement level (USD) — tracks the live mark until you edit it">
                  <div className="flex items-center gap-1.5">
                    <input
                      className={input}
                      type="number"
                      step="0.0001"
                      value={strike}
                      onChange={(e) => {
                        setStrikeTouched(true);
                        setStrike(+e.target.value);
                      }}
                    />
                    {liveMark != null && asset === SPCX.symbol && strikeTouched && (
                      <button
                        type="button"
                        onClick={() => {
                          setStrikeTouched(false);
                          setStrike(Math.round(liveMark * 100) / 100);
                        }}
                        className="shrink-0 rounded-[6px] border border-line-strong px-2 py-1.5 font-mono text-[11px] text-ink hover:bg-bg"
                        title="snap back to the live oracle mark"
                      >
                        ↺ live
                      </button>
                    )}
                  </div>
                </Labeled>
              )}
              <Labeled label="Price source (oracle)">
                <Segmented
                  value="keeper"
                  onChange={() => {}}
                  options={[
                    { value: "keeper", label: "Fullmetal keeper" },
                    { value: "pyth", label: "Pyth", disabled: "integration in progress" },
                    { value: "deepbook", label: "DeepBook mid", disabled: "single-venue; needs TWAP" },
                  ]}
                />
              </Labeled>
              <Labeled label="Funding fee" hint="forwards price carry into the strike — no funding leg">
                <Segmented
                  value="none"
                  onChange={() => {}}
                  options={[
                    { value: "none", label: "None (forward)" },
                    { value: "fixed", label: "Fixed", disabled: "funding applies to Perp/Hybrid" },
                    { value: "variable", label: "Variable", disabled: "needs an index/premium feed: post-MVP" },
                  ]}
                />
              </Labeled>
            </Section>

            {/* Timing — three distinct clocks */}
            <Section label="Timing">
              <div className="grid gap-4 sm:grid-cols-3">
                <Labeled label="Offer expires in" hint="mins">
                  <input className={input} type="number" value={offerMins} onChange={(e) => setOfferMins(+e.target.value)} />
                </Labeled>
                <Labeled label="Contract maturity" hint="days">
                  <input className={input} type="number" value={maturityDays} onChange={(e) => setMaturityDays(+e.target.value)} />
                </Labeled>
                <Labeled label="Settlement (MTM)">
                  <select className={input} value={interval} onChange={(e) => setInterval(e.target.value as "daily" | "hourly")}>
                    <option value="daily">Daily</option>
                    <option value="hourly">Hourly</option>
                  </select>
                </Labeled>
              </div>
              <p className="mt-2 text-[11px] leading-[1.6] text-faint">
                Offer-expiry bounds the unaccepted offer · maturity bounds the live trade · settlement is the recurring mark-to-market.
              </p>
            </Section>

            {/* Collateral & rehypothecation */}
            <Section label="Collateral & rehypothecation">
              <Labeled label="Initial margin, each side" hint={`min ${usd(minIm)}`}>
                <input
                  className={`${input} ${imValid ? "" : "border-[#b4341f]"}`}
                  type="number"
                  value={im}
                  onChange={(e) => { setImTouched(true); setIm(+e.target.value); }}
                />
              </Labeled>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-muted">
                <span>Leverage <span className="text-ink">{leverage ? leverage.toFixed(1) : "—"}×</span></span>
                <span>Maintenance <span className="text-ink">{usd(maintenance)}</span> · 70% of IM</span>
                <span>Settlement <span className="text-ink">USDC</span> · auto-liquidation</span>
              </div>

              <Labeled label="Rehypothecate idle margin to" hint="live USDC supply APR">
                <div className="flex flex-col gap-2.5">
                  <Check checked={rehypo} onChange={setRehypo} label="DeepBook margin" logo="/logos/deepbook.png" apr={rates?.rates.deepbook} />
                  <Check checked={false} disabled label="Suilend" hint="allocate from the Collateral manager" logo="/logos/suilend.png" apr={rates?.rates.suilend} />
                  <Check checked={false} disabled label="Navi" hint="allocate from the Collateral manager" logo="/logos/navi.png" apr={rates?.rates.navi} />
                </div>
              </Labeled>
            </Section>

            {/* preview + submit */}
            <div className="mt-7 rounded-[10px] border-[0.5px] border-line bg-bg p-4 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-muted">You post</span>
                <span className="font-mono text-ink">{usd(im)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted">Counterparty posts</span>
                <span className="font-mono text-ink">{usd(im)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-muted">Notional</span>
                <span className="font-mono text-ink">{usd(notionalUsd)}</span>
              </div>
            </div>

            {error && <p className="mt-3 break-words text-[12px] leading-[1.6] text-[#b4341f]">{error}</p>}

            <button
              disabled={!valid || busy}
              onClick={submit}
              className="mt-4 flex w-full items-center justify-center rounded-[7px] border-[0.5px] border-line-strong bg-ink px-4 py-3 text-[14px] text-bg transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy
                ? "Submitting…"
                : entry === "direct"
                  ? "Propose contract →"
                  : "Broadcast RFQ →"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Success({ done, onClose }: { done: OtcResult; onClose: () => void }) {
  return (
    <div className="mt-6">
      <p className="text-[14px] text-ink">
        {done.kind === "direct" ? "Direct offer sent." : "RFQ broadcast."} Margin firm-reserved; the counterparty can now accept.
      </p>
      <a
        href={explorer.object(done.offerId)}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-block font-mono text-[12px] text-muted underline hover:text-ink"
      >
        {done.offerId.slice(0, 12)}… ↗
      </a>
      <button
        onClick={onClose}
        className="mt-6 w-full rounded-[7px] border-[0.5px] border-line-strong px-4 py-3 text-[14px] text-ink hover:bg-bg"
      >
        Done
      </button>
    </div>
  );
}

// ---- small UI atoms ----

const input =
  "w-full rounded-[7px] border-[0.5px] border-line bg-bg px-3 py-2.5 text-[14px] text-ink outline-none transition-colors focus:border-line-strong";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-6 border-t-[0.5px] border-line pt-5 first:border-t-0">
      <p className="mb-3 font-mono text-[11px] uppercase tracking-[0.16em] text-muted">{label}</p>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] tracking-[0.03em] text-ink-soft">{label}</span>
        {hint && <span className="text-[11px] text-faint">· {hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Segmented({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: string }[];
}) {
  return (
    <div className="inline-flex w-full rounded-[7px] border-[0.5px] border-line p-0.5">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            title={o.disabled}
            disabled={!!o.disabled}
            onClick={() => !o.disabled && onChange(o.value)}
            className={`flex-1 rounded-[5px] px-3 py-2 text-[13px] transition-colors ${
              active ? "bg-ink text-bg" : "text-ink-soft hover:text-ink"
            } ${o.disabled ? "cursor-not-allowed opacity-35 hover:text-ink-soft" : ""}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Check({
  checked,
  onChange,
  label,
  hint,
  disabled,
  logo,
  apr,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
  logo?: string;
  apr?: number;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`flex w-full items-center gap-2.5 text-left text-[13px] ${disabled ? "cursor-not-allowed" : ""}`}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[4px] border-[0.5px] ${
          checked ? "border-ink bg-ink text-bg" : disabled ? "border-line" : "border-line-strong"
        }`}
      >
        {checked && <span className="text-[10px] leading-none">✓</span>}
      </span>
      {logo && <Image src={logo} alt="" width={18} height={18} className="shrink-0 rounded-[4px]" />}
      <span className={disabled ? "text-ink-soft" : "text-ink"}>{label}</span>
      {hint && <span className="text-[11px] text-faint">· {hint}</span>}
      {apr != null && (
        <span className="ml-auto font-mono text-[12px] font-semibold text-[#1a6042]">{apr.toFixed(2)}% APR</span>
      )}
    </button>
  );
}
