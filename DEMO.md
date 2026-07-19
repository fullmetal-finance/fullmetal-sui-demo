# Demo-day runbook

Everything below was verified live on testnet (2026-07-10): the EWMA
latch/release loop (`scripts/vol-smoke.ts` — PASS), and the full margin-call →
cure → survive → release drill through the app's own API (`scripts/drill-smoke.ts` — PASS).

## One-time setup / after a break

```bash
# 0. balances — ops wallet 0x6849af…d5576 wants ≥ 2 SUI and ≥ 150 DBUSDC per run
#    (+ ~0.3 SUI per demo account if Enoki is down: the app then auto-falls back
#    to SELF-PAID gas — /api/gas tops the zkLogin address up from the ops wallet,
#    the tx goes out over plain JSON-RPC. Enoki is retried first every ~2 min.)
#    SUI: https://faucet.sui.io/?address=0x6849af55b4f2f429cb2665ec9f4d42c17eecc76211f14caf959903ad786d5576
cd scripts
npx tsx swap-dbusdc.ts 300      # top up DBUSDC by swapping faucet SUI
npx tsx sweep-desks.ts          # recover DBUSDC from rehearsal desks

# 1. clean stage (SPCX → $148, trigger cleared, EWMA re-seeded) + pre-flight checks
npx tsx demo-reset.ts

# 2. app
cd ../frontend && npm run dev   # http://localhost:3000
```

**Starting a demo account afresh:** sign in with the account → dashboard →
**↺ reset desk** (next to the institution id). Local-only and instant — no
transactions, nothing to fail: it clears the account's browser records and
reopens onboarding. The old institution and its test funds simply stay parked
on-chain, and the old **handle stays taken** (registry is append-only — pick a
new one). Equivalent manual fallback: clear localStorage for localhost:3000.
(If parked funds ever need recovering, `frontend/lib/reset-desk.ts` +
`scripts/reclaim-smoke.ts` hold a verified on-chain reclaim flow — permissionless
closes/reclaims work from the ops key too; withdrawal needs the account's own
sign-in. Not wired into the UI: Enoki's execute endpoint proved flaky.)

## The demo script

1. **Onboarding** — landing → Get started → profile form → Sign in with Google
   (zkLogin, no seed phrase) → *Create institution* (one sponsored, gasless tx).
2. **Fund** — *Load funds* → **$42** (mock on-ramp mints DBUSDC and deposits
   it). $42 is the drill window, not a random number — see step 6.
3. **RFQ** — *New OTC contract* → *Broadcast (RFQ)* → SPCX, 1 unit, IM $8
   (default = 5% of the live mark; fractional quantities work too — 0.5 SPCX).
   The modal shows the **SPCX daily market chart** — Nasdaq-style candles from
   the June-12 IPO (priced $135) to today, with **today's candle live**: its
   close IS the keeper mark contracts settle on, so a crash demo prints the red
   daily candle in real time. Click it to project it full-screen (hover for
   per-day OHLC; Esc closes). Broadcast →
   the three desks (Cumberland / Galaxy Digital / Wintermute) price **off the
   live oracle mark** (asks +12/+25/+40 bps for a long requester; bids below
   for a short) and their firm, collateral-backed quotes land as **on-chain
   objects**. The inbox re-discovers them **from the chain every few seconds**
   — a refresh, a lost response, or a second browser cannot lose them — with a
   live TTL countdown per quote. If the desks can't quote, the inbox shows the
   server's exact reason with a **↻ Retry** button (never a silent preview).
   **Accept** the best (long → lowest ask wins). The IM auto-rehypothecates to
   DeepBook.
4. **Cross-margin** — *Positions* tab → the **Cross-margin panel**. Three
   things prove the pooling on screen: (a) the **pool bar** — every trade's IM
   is a colored hold *inside one treasury bar*, the rest is labelled "one
   shared VM buffer — not split per trade", the red rule is the Σ-maintenance
   floor; (b) the **VM-netting readout** — each position's live mark-to-market
   flow and the single **"pool settles NET"** figure (with 2 opposing
   positions, say it: *gains on one leg back losses on the other before any
   new capital moves — siloed accounts would move both gross legs*); (c) the
   **buffer-coverage chip** — free buffer ÷ Σ maintenance, desk health in one
   number. Rows below carry per-contract health chips + the margin-call
   countdown/crank.
5. *(optional second position — great for the cross-margin beat)* — *New OTC*
   → *Direct* to `cumberland` (or another maker desk), SPCX, the **opposing
   side** (short if the first is long) so the VM-netting panel lights up. The
   maker desk **auto-accepts** (like RFQ — via `/api/accept-direct`), so the
   opened contract lands in the blotter + cross-margin on the next refresh —
   no script needed. NOTE: a direct trade is only a *contract* once accepted;
   proposing reserves + deploys your IM, but nothing shows in the blotter until
   the counterparty accepts. (Fallback if the maker service is offline:
   `npx tsx accept-direct.ts <offerId>` from `scripts/`, offer id shown in the
   app. A direct offer to a REAL desk waits for that desk to accept.)
6. **Collateral manager** — POLICY: **only the locked margin is
   rehypothecated** (the allocation strip shows it: free liquidity — the
   VM/PnL buffer the desk reloads daily — never leaves the treasury; only
   the locked IM deploys). Venues: DeepBook (**real** testnet margin-pool
   txs) and Suilend/Navi (**SIM** badges, live mainnet APRs). The IM
   auto-deploys to DeepBook on contract open (RFQ: at **accept** — nothing
   locks or deploys while quotes are pending); **⇄ Rebalance** then moves it
   venue→venue (DeepBook legs are real txs; SIM legs instant) — a good beat
   for "policy is admin-tunable". SIM balances reconcile exactly: interest
   accrues inside the venue value and lands in liquid when withdrawn
   (invariant-tested). **Floor policy**: new desks are created with the
   on-chain liquidity floor at **$0 — the WHOLE locked IM is deployable**.
   The *Floor policy* row flips it live to the prudent default (25% of locked
   IM must stay liquid; deploys below the floor abort code 24) and back — an
   admin-signed on-chain policy tx, a strong "risk policy is tunable" beat.
   The red marker on the allocation strip is that floor (hidden at $0). Desks
   created before this default keep 25% until the row is clicked once.
   **Desk sizing: fund $42.** Two numbers rule every beat: AVAILABLE capital
   = equity − locked IM (a desk's own IM can never pay its own VM — deployed
   or not; and under IM-only deploys, a recall never changes available, it
   only moves funds home), and the crash VM ($28–31 for 1 SPCX @ ~$148 on
   the −19…21% crash). At $42: available $34 ≥ VM → the crash beat PAYS
   every VM step and SURVIVES with no margin call — the recall's job there
   is the VENUE leg (collateral out of harm's way before the storm), not the
   paying. A margin call fires exactly when available < VM — organically true
   for the post-crash desk in step 8 (≈$12 left vs ≈$22 VM) — and the
   only cure that ADDS capital is the **daily treasury reload**, which
   auto-cure wires automatically (+$20 via the mock on-ramp).
7. **THE BEAT — the pre-empted crash** — **▶ Start live market**. A continuous
   ticker streams real on-chain prints (~1.5 s cadence) with the EWMA σ track
   under the price. Let it breathe a few seconds, then hit **💥 Crash**.
   Real crashes cluster — tremors first — and that is exactly what the risk
   layer exploits:
   - **tremor 1 (−3…4%)**: tiny vs the coming leg, but z ≫ 4σ against the calm
     regime → **trigger latches on-chain** → the **permissionless recall
     fires** → collateral is HOME (red marker: `RECALL`). *Say it: "the money
     left before the crash."*
   - **tremor 2 (−4…5%), then the main leg (−12…13%)**: the desk pays each
     VM step from its available capital — **positions survive with no margin
     call** — while the collateral sits safely home instead of at a venue
     that could gate or haircut it mid-storm.
   - the aftermath chops; σ decays through the violet track; **the latch
     holds, so the desk STAYS OUT** (release pips 1/3 → 2/3; an out-of-band
     print resets them — organic).
   - ~6–7 prints later: 3 calm prints in-band → **latch auto-releases
     on-chain** → the calm indicator is met → the desk **redeposits** (green
     marker: `REDEPOSIT`).
   The market keeps ticking — **≈ Calm** settles it, then **■ Stop**.
   Crash → redeposit ≈ 20–25 s. Every print, the recall, the cranks, and the
   redeposit are real testnet txs (links in the panel footer).
   **▲ Spike** is the same beat UPWARD (the EWMA is symmetric): gradual
   +3…5% tremors latch the trigger and recall before the +12…13% main leg —
   proof the risk layer responds to volatility in either direction.
8. **Liquidation encore** (optional) — the due-process / liquidation path
   still lives on-chain; with the pre-empted crash it only fires if the desk
   can't cover after the recall. To force it: fund the desk **thin** (below the
   ~$39 window in step 6 — e.g. $30), untick *auto-cure*, then **💥 Crash**.
   The recall brings collateral home but AVAILABLE capital still can't cover the
   VM → **MARGIN CALL** (90 s cure countdown; the chip names the debtor). With
   auto-cure off there's no reload, so it ages past the window → *Crank
   settlement* → **LIQUIDATED** chip.
   ⚠ **Desk sizing matters**: a margin call cures only if AVAILABLE capital
   (equity − locked IM) covers the VM after auto-cure's +$20 reload. A desk
   too deep even then holds an **uncurable** call — it WILL liquidate on the
   next crank no matter what you press (that IS this encore: auto-cure off =
   no reload = the call ages out). Fund $42 per
   the step-2 recipe (step-6 window). Margin calls are **side-aware on-chain**
   (this upgrade): the panel chip names the debtor — *"MARGIN CALL — you owe"*
   vs *"cpty margin-called — they owe you"* — and if the mark flips the owing
   side, the old window is VOID and the new loser gets a FRESH cure window
   (previously a flip liquidated the new loser against the stale clock;
   observed live 2026-07-12). Reset still defuses stale calls on open
   contracts as a belt-and-braces measure.
   NOTE: contracts **past expiry** can't be cranked or recalled against (abort
   78) — they show `EXPIRED · settle via close` in the margin panel and are
   excluded automatically. For a clean stage, start from a fresh desk (clear
   localStorage) rather than reusing week-old contracts.

## Fallbacks

- **RPC**: reads default to `rpc-testnet.suiscan.xyz` (the official fullnode is
  gRPC-only now). If it degrades: `NEXT_PUBLIC_SUI_RPC_URL=https://sui-testnet-endpoint.blockvision.org`
  (+ same in `SUI_RPC_URL`) and restart. Writes (Enoki/dApp Kit) use gRPC on the
  official node and are unaffected.
- **Enoki 5xx / execute outage** (seen 2026-07-11: sponsor 200 but execute
  hangs ~30s → 502, Mysten-side; our request shape verified good against their
  API — reported to Mysten): the executor self-heals in three stages —
  (1) sponsorship retries with backoff, (2) an execute failure first checks
  whether the digest actually LANDED on-chain before retrying full-cycle, and
  (3) if Enoki's rails are still failing, it **auto-falls back to SELF-PAID
  gas**: `/api/gas` tops the zkLogin address up from the ops wallet and the
  same PTB goes out over plain JSON-RPC (no Enoki leg). A 2-min cooldown then
  skips Enoki so later actions are fast; Enoki gets first shot again after.
  On stage the FIRST action during an outage costs ~60s of discovery; the rest
  are normal speed. Tx-level errors (dry-run failures) still surface — the
  fallback only fires on Enoki infrastructure errors. If everything is down,
  fall back to the recorded run.
- **Maker quotes**: delivery is chain-truth — the inbox polls `/api/makers`
  (GET), which recovers every LIVE quote object from the recent `submit_quote`
  transactions, so nothing depends on a browser response surviving. If a
  broadcast draws no quotes the inbox shows the server's reason + **Retry**.
  Requirements: the app's server key (`FAUCET_SECRET_KEY` env or the `~/.sui`
  active key) must OWN the three maker desks' caps and hold DBUSDC for IM
  top-ups — a hosted deployment with a different key fails loudly with exactly
  that message. POST is idempotent: desks that already have a live quote on the
  RFQ are skipped, so a retry can never double-quote.
- **Keeper equivocation**: all server-side ops-key transactions (ticks, cranks,
  cure recalls, maker quotes, gas top-ups) are SERIALIZED through one queue —
  overlapping writes used to be "rejected as invalid by more than 1/3 of
  validators" (same gas coin, two in-flight txs; observed live 2026-07-17).
  If that error ever reappears, it self-clears on the next tick.
- **Manual mode**: the collateral manager keeps a manual *Push print* field —
  same on-chain machinery, one print at a time (the threshold label shows the
  live latch level).
- **Between runs**: `npx tsx demo-reset.ts` (stage) + `npx tsx sweep-desks.ts`
  (funds). A stuck latch mid-demo: the *Reset* button in the app does the same
  atomic reset.
- Record one clean rehearsal as a video backup.

## What is real vs simulated

Real on testnet: institution, treasury, RFQ + quotes + accept, OTC forwards,
cross-margin reserve/release, `settle_on_breach` margin calls & liquidation
(90 s demo cure window; production ~10 min; **side-aware** — the call names its
debtor and a mark flip opens a fresh window; liquidation pays capped at
`available`, so another contract's locked IM is never touched and deep
insolvency can no longer abort the crank), the **on-chain IM-only rule**
(deploys beyond locked IM abort code 25), DeepBook rehypothecation,
EWMA oracle latch/release, permissionless `recall_on_trigger`.
Simulated (badged **SIM**): Suilend/Navi balances — they accrue at the **live**
mainnet APRs and their supply/withdraw PTBs are validated against live mainnet
(`scripts/suilend-rehypo.ts`, `scripts/navi-rehypo.ts` under `DRYRUN=1`).

## Deployed ids (testnet, current)

| Thing | Id |
|---|---|
| Package (current, this upgrade) | `0x141f7de4ea75cde406d424a0669e17e34352ef9fd594bcae6f0139ef6dd74700` |
| SPCX EWMA calibration | seed σ 150 bps · λ 0.60 · z\* 4.0σ · ceil 800 bps · release < 560 bps × 3 prints |
| RiskOracle | `0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd` |
| DBUSDC margin pool | `0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d` |
