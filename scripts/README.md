# Scripts

Two families: **testnet operations** for the deployed demo package, and
**mainnet venue validations** that prove the Suilend/Navi rehypothecation legs
against live protocol state without moving funds. Run everything with
`npx tsx <script>.ts` from this directory (`npm install` once).

## Testnet operations (deployed demo)

| Script | What it does |
|---|---|
| `deploy-test.ts` | publish the package via the SDK (MVR-resolved deps) + create singletons |
| `upgrade.ts` | package upgrade (compatible policy) |
| `allowlist.ts` | allowlist the `OtcWitness`/`RfqWitness` type-names via `ProtocolCap` |
| `two-inst-rfq.ts` / `two-inst-direct.ts` | end-to-end two-desk RFQ / direct-offer flows with real DBUSDC |
| `makers-quote.ts` | post the demo maker quotes |
| `swap-dbusdc.ts`, `margin-pool-stats.ts` | DBUSDC utilities / DeepBook pool reads |

## Mainnet venue validations (`suilend-rehypo.ts`, `navi-rehypo.ts`)

Suilend and Navi are **mainnet-only**, so these scripts validate the
integration the institution will use — supply USDC, hold the venue receipt,
recall — as pure PTBs against the *live* mainnet deployments. Three modes,
escalating in strictness:

```bash
npx tsx suilend-rehypo.ts                       # read-only: live reserve state, no sender
SUI_SENDER=0x… npx tsx suilend-rehypo.ts        # devInspect the supply leg (gas-free simulation)
DRYRUN=1 SUI_SENDER=0x… npx tsx suilend-rehypo.ts   # full round-trip under dryRun
```

The `DRYRUN=1` mode is the one that counts: it builds a **single PTB
round-trip** (supply → redeem/withdraw, everything back to the sender) and runs
it under `dryRunTransactionBlock`, which — unlike `devInspect` — enforces
function **visibility** and real gas. Nothing is committed; the sender needs a
little USDC + SUI on mainnet. Expected results: Suilend nets to −0.000001 USDC
(one micro-unit of share-rounding dust); Navi nets to −0.01 (intentionally left
supplied to dodge index rounding).

Hard-won facts these scripts encode — do not "simplify" them away:

- **devInspect lies about visibility.** Navi's `account::create_account_cap` is
  `public(package)` and *passes* devInspect; the real public path is
  `lending::create_account`. Anything validated only by devInspect is not
  validated.
- **Navi withdraw needs a same-PTB oracle refresh.** The on-chain freshness
  window is 15 s (`update_interval`) but Navi's keepers push every few minutes,
  so a bare withdraw aborts (code 1502 in `calculator::calculate_value`). The
  script prepends `updateOracleByIdsPTB(client, tx, [10])` (nUSDC oracleId 10)
  from `navi-sdk` — which requires `@pythnetwork/pyth-sui-js` **pinned to
  2.1.0** (2.4.0 removed `getLatestPriceFeeds`, which navi-sdk calls).
- **Navi's package id churns.** Upgrades are frequent and a version guard
  bricks stale callers; the script fetches the current id from
  `open-api.naviprotocol.io/api/package` at runtime, with a hardcoded fallback.
  Navi API amounts are 1e9-scaled.
- **Suilend redeem** takes `Option<RateLimiterExemption>` = `none` — the
  protocol-wide outflow rate limiter is why Suilend's recall latency is not
  always "one transaction" (priced into the risk model as √t_recall; see
  [RISK-RESPONSIVE-REHYPOTHECATION.md](../RISK-RESPONSIVE-REHYPOTHECATION.md) §4).
- Suilend calls target the **current** package id while types stay keyed to the
  **original** id — targeting the original aborts with `EIncorrectVersion`.

The real (funds-moving) runs are deliberately not wired into either script.
