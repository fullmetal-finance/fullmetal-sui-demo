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

# 1. clean stage (SPCX → $185, trigger cleared, EWMA re-seeded) + pre-flight checks
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
2. **Fund** — *Load funds* → $100 (mock on-ramp mints DBUSDC and deposits it).
3. **RFQ** — *New OTC contract* → *Broadcast (RFQ)* → SPCX, 1 unit, IM ≥ $9.25
   → broadcast. Three desks (Cumberland / Galaxy Digital / Wintermute) respond
   with firm, collateral-backed quotes on-chain → **Accept** the best. The IM
   auto-rehypothecates to DeepBook.
4. **Cross-margin** — *Positions* tab → the **Cross-margin panel**: one pooled
   treasury bar, the trade's IM fenced inside it (never siloed), Σ maintenance
   rule, live health chips.
5. *(optional second position for a 2-contract drill)* — *New OTC* → *Direct*
   to `cumberland`, SPCX, 1 unit, long. Then from `scripts/`:
   `npx tsx accept-direct.ts <offerId>` (offer id is shown in the app). The
   contract lands in the blotter on the next refresh.
6. **Collateral manager** — deploy across the three venues:
   DeepBook (**real** testnet margin-pool txs) and Suilend/Navi (**SIM**
   badges, live mainnet APRs). For the margin-call beat, deploy until
   **liquid < $37** (e.g. $100 desk: DeepBook 40 + Suilend 20 + Navi 10 →
   liquid $30). The on-chain liquidity floor is shown under the gauge.
7. **THE BEAT** — **▶ Start live market**. A continuous ticker streams real
   on-chain prints (~1.5 s cadence) with the EWMA σ track under the price.
   Let it breathe a few seconds, then hit **💥 Crash**:
   - the −18…22% gap print **latches the trigger on-chain** (z ≫ 4σ) →
     positions get **MARGIN CALLS** (funds are deployed — due process, not
     instant death; 90 s cure countdown on the margin panel) → auto-cure runs
     the **permissionless recall** → VM paid from pooled treasury →
     **positions survive** (red marker: `RECALL`).
   - the aftermath chops; σ decays through the violet track; latch holds
     (release pips 1/3 → 2/3; an out-of-band print resets them — organic).
   - ~6–7 prints later: 3 calm prints in-band → **latch auto-releases
     on-chain** → the desk **redeposits** (green marker: `REDEPOSIT`).
   The market keeps ticking — run **another 💥 Crash** for a second cycle, or
   **≈ Calm** to settle it, then **■ Stop**. Crash → redeposit ≈ 15–20 s.
   Every print, the recall, the cranks, and the redeposit are real testnet
   txs (links in the panel footer).
8. **Liquidation encore** (optional) — untick *auto-cure*, 💥 Crash again:
   the margin call ages past the 90 s cure window (countdown on the margin
   panel) → *Crank settlement* → **LIQUIDATED** chip.
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
(90 s demo cure window; production ~10 min), DeepBook rehypothecation,
EWMA oracle latch/release, permissionless `recall_on_trigger`.
Simulated (badged **SIM**): Suilend/Navi balances — they accrue at the **live**
mainnet APRs and their supply/withdraw PTBs are validated against live mainnet
(`scripts/suilend-rehypo.ts`, `scripts/navi-rehypo.ts` under `DRYRUN=1`).

## Deployed ids (testnet, current)

| Thing | Id |
|---|---|
| Package (current, this upgrade) | `0xf8b57f09dfe5e59fcc176110c8f15cf96b27f6f23be8a4db959529d896635a4a` |
| SPCX EWMA calibration | seed σ 150 bps · λ 0.60 · z\* 4.0σ · ceil 800 bps · release < 560 bps × 3 prints |
| RiskOracle | `0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd` |
| DBUSDC margin pool | `0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d` |
