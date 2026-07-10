# Demo-day runbook

Everything below was verified live on testnet (2026-07-10): the EWMA
latch/release loop (`scripts/vol-smoke.ts` — PASS), and the full margin-call →
cure → survive → release drill through the app's own API (`scripts/drill-smoke.ts` — PASS).

## One-time setup / after a break

```bash
# 0. balances — ops wallet 0x6849af…d5576 wants ≥ 2 SUI and ≥ 150 DBUSDC per run
#    SUI: https://faucet.sui.io/?address=0x6849af55b4f2f429cb2665ec9f4d42c17eecc76211f14caf959903ad786d5576
cd scripts
npx tsx swap-dbusdc.ts 300      # top up DBUSDC by swapping faucet SUI
npx tsx sweep-desks.ts          # recover DBUSDC from rehearsal desks

# 1. clean stage (SPCX → $185, trigger cleared, EWMA re-seeded) + pre-flight checks
npx tsx demo-reset.ts

# 2. app
cd ../frontend && npm run dev   # http://localhost:3000
```

If the signed-in demo account should start fresh: clear the browser's
localStorage for localhost:3000 (institution/quotes live there), or use a new
Google test user.

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
7. **THE BEAT** — scenario `Flash crash` → **Run**. Watch the chart draw each
   on-chain print + the EWMA σ track:
   - tick 4 (−20% gap, z ≈ 27σ): **trigger latches on-chain** → positions get
     **MARGIN CALLS** (funds are deployed — due process, not instant death;
     90 s cure countdown on the margin panel) → auto-cure runs the
     **permissionless recall** → VM paid from pooled treasury → **positions
     survive** (red marker: `RECALL $70`).
   - chop: σ decays; latch holds (release pips 1/3 → 2/3).
   - tick 10: 3 calm prints → **latch auto-releases on-chain** → the desk
     **redeposits** (green marker: `REDEPOSIT`).
   Total ≈ 25–35 s. Every print, the recall, the cranks, and the redeposit
   are real testnet txs (links in the panel footer).
8. **Liquidation encore** (optional) — untick *auto-cure*, reset, run again:
   the margin call ages past the 90 s cure window (countdown on the panel) →
   *Crank settlement* → **LIQUIDATED** chip.

## Fallbacks

- **RPC**: reads default to `rpc-testnet.suiscan.xyz` (the official fullnode is
  gRPC-only now). If it degrades: `NEXT_PUBLIC_SUI_RPC_URL=https://sui-testnet-endpoint.blockvision.org`
  (+ same in `SUI_RPC_URL`) and restart. Writes (Enoki/dApp Kit) use gRPC on the
  official node and are unaffected.
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
