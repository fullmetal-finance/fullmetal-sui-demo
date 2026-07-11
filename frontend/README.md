# Fullmetal demo — frontend

The institutional desk web app: onboarding, treasury, OTC contract creation, an RFQ
inbox, and the collateral manager (the rehypothecation + oracle-recall loop). It drives
the [Fullmetal](../README.md) protocol end-to-end on Sui testnet.

## Stack

- **Next.js 16** (App Router) + **React 19**, **Tailwind CSS v4**, Geist fonts.
- **@mysten/dapp-kit 2.0** + **@mysten/enoki** — zkLogin wallets ("Sign in with Google",
  no seed phrase) and sponsored (gasless) transactions.
- **@mysten/sui 2.x** for reads and transaction building; **@mysten/deepbook-v3** types.

## What's real vs mocked

- **Real on-chain (testnet):** creating an institution, depositing, opening OTC forwards
  (direct + RFQ-accept), rehypothecate / recall, the oracle trigger and recall.
- **Live mainnet reads:** USDC supply APRs **plus per-venue risk metrics**
  (utilization + withdrawable liquidity for all three; rate-model kink for DeepBook
  and Suilend — Navi's API doesn't expose it, so that field is null — the
  venue-adapter reads of RISK-RESPONSIVE-REHYPOTHECATION.md §4) for DeepBook margin,
  Suilend, and Navi. DeepBook/Suilend come from each pool's on-chain interest model
  over a public RPC; Navi from its official REST API (`/api/rates`, no API keys;
  response has `rates`, `live`, and `risk` blocks).
- **Mocked for the demo:** the off-chain institution profile (localStorage), the maker
  quote-service responses, the trader roster, incoming RFQs, and the on-ramp card.

## Setup

Requires Node 20+ and a `frontend/.env.local`:

```bash
# Enoki — zkLogin + sponsored transactions  (https://portal.enoki.mystenlabs.com)
NEXT_PUBLIC_ENOKI_API_KEY=enoki_public_...
ENOKI_PRIVATE_API_KEY=enoki_private_...          # server-only; sponsors transactions

# Google OAuth client — the zkLogin provider  (https://console.cloud.google.com)
NEXT_PUBLIC_GOOGLE_CLIENT_ID=...apps.googleusercontent.com

# Optional: server keypair for the faucet/oracle routes.
# Falls back to the active key in ~/.sui if unset.
FAUCET_SECRET_KEY=suiprivkey...
SUI_ADDRESS=0x...
```

Then:

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

### OAuth redirect

zkLogin redirects to `<origin>/auth/callback`. Register that exact URI (**scheme
included** — `https` in production) in the Google OAuth client's *Authorized redirect
URIs*, and the origin in *Authorized JavaScript origins* plus the Enoki app's allowed
origins. Vercel preview URLs change per deploy, so test sign-in on a stable domain.

## Structure

```
app/
  page.tsx              landing
  onboarding/           create an institution desk (zkLogin)
  dashboard/            treasury, positions, RFQ inbox, collateral manager
  auth/callback/        zkLogin redirect target
  components/           RehypoHero (collateral manager), Blotter, QuotesInbox,
                        MarketRfqs, CreateOtcModal, RatesBar, ManageModal, ...
  api/
    sponsor, execute    Enoki sponsored-transaction backend
    gas                 SUI top-up from the ops wallet (self-paid fallback path)
    faucet              mock fiat on-ramp (mints + returns DBUSDC)
    oracle              keeper push / spike / recall sequence
    makers              mock competing RFQ quotes
    rates               live USDC supply APRs + venue risk reads (DeepBook / Suilend / Navi)
lib/
  fullmetal.ts          on-chain config — package, singletons, Move-call targets
  sponsored.ts          gasless execute hook (build kind → sponsor → sign → execute;
                        auto-falls back to self-paid gas via /api/gas when Enoki fails)
  institution-state.ts  on-chain reads (treasury, positions, oracle)
  otc.ts / quotes.ts    create OTC + accept RFQ quote
  rehypo-actions.ts     rehypothecate / recall hooks
  oracle.ts / rates.ts  oracle controls + live-rate hook
  store.ts              localStorage profile / quote persistence
```

## Demo flow

1. **Onboarding** — sign in with Google; create an institution desk (admin name, legal
   entity, handle). One sponsored transaction shares the `Institution` object.
2. **Load funds** — the mock on-ramp faucets DBUSDC and deposits it to the treasury.
3. **New OTC contract** — direct (type a counterparty handle) or RFQ (broadcast; three
   desks quote, accept the best). Posted IM auto-rehypothecates to DeepBook. The
   **cross-margin panel** shows the trade's IM fenced inside the one pooled treasury.
4. **Collateral manager** — allocate across DeepBook (real testnet txs) and
   Suilend/Navi (SIM-badged, live mainnet APRs), above the on-chain liquidity floor.
   Then **▶ Start live market**: a continuous ticker streams real on-chain
   `push_price_v2` prints (~1.5 s cadence) with 💥 Crash / ▲ Spike / ≈ Calm
   injection buttons. A crash latches the EWMA σ trigger → breached positions take
   **margin calls** (90 s cure window) → the **permissionless recall** brings
   collateral home and the positions pay & survive → three calm prints later the
   latch **auto-releases on-chain** and the margin redeposits. The chart marks the
   recall and redeposit ticks with their tx links. (A manual *Push print* field
   drives the same machinery one print at a time.) See [DEMO.md](../DEMO.md) for
   the full runbook.

The protocol architecture (object model, accounting, capability auth, lifecycle flows)
is in [ARCHITECTURE.md](https://github.com/fullmetal-finance/fullmetal-sui-demo/blob/main/ARCHITECTURE.md).
