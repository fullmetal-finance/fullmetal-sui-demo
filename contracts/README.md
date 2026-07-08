# `fullmetal` — the Move package

The on-chain protocol: pooled cross-margined institutions, bilateral
forwards/perps with maintenance-breach liquidation, two flavors of RFQ, a
volatility oracle, and risk-responsive rehypothecation. Design rationale lives
in [ARCHITECTURE.md](../ARCHITECTURE.md) (object model, auth, lifecycle) and
[WHITEPAPER.md](../WHITEPAPER.md) (the math); this file is the *working* guide:
what's here, how to build and test it, and the toolchain quirks you will hit.

## Modules

| Module | What it owns |
|---|---|
| `institution` | the tenant: one shared pooled treasury, IM fences (`reserved`), traders/admins/caps, the `public(package)` seams everything else uses |
| `otc_forward` | the contract: SD29x9 PnL, pro-rata funding, cadence settlement, **`settle_on_breach`** (permissionless MM crank + 10-min margin-call cure window), liquidation |
| `settlement` | hot-potato atomic value transfer between institutions |
| `rfq` / `direct` | firm collateral-backed quotes / named-counterparty offers (deployed demo paths) |
| `rfq_twoway` | information-disciplined RFQ: no direction, bid+ask quotes, single-shot per maker, bucket ceilings (WHITEPAPER §5.1 Phase A) |
| `oracle` | keeper-pushed marks; legacy jump trigger + **EWMA vol layer** (`enable_vol`, `push_price_v2`, hysteresis) |
| `rehypo` | DeepBook-linked rehypothecation (testnet live path, `SupplierCap` in a dynamic field) |
| `rehypo_router` | venue-agnostic core: `RehypoConfig` (margin bps + liquidity floor + venue caps), hot-potato supply/recall tickets for external adapters |
| `protocol` / `registry` | witness allowlist (`ProtocolCap`-gated); unique handle → institution id |
| `errors` / `events` | canonical abort codes (getters); BCS-stable indexer events |

## Build & test

```bash
sui move build        # needs Sui CLI ≥ 1.74 (see toolchain notes)
sui move test         # 40 tests
```

Test files map to feature areas: `lifecycle_tests` (institution/treasury/margin
seams), `otc_tests` (settlement + liquidation), `rfq_tests` / `direct_tests`,
`twoway_tests` (two-way RFQ: side hidden until accept, single-shot, buckets),
`crossmargin_tests` (breach crank: grace, margin-call-then-liquidate, funding
telescoping), `risk_tests` (EWMA traces, hysteresis, liquidity floor, router
tickets).

## Toolchain notes (read before touching Move.toml)

- **Sui CLI ≥ 1.74 and `edition = "2024.alpha"`** are required — the test build
  uses `extend module` (module extensions), which 2024-proper rejects and
  1.72.x mishandles.
- **`tests/pyth_ext.move` is a shim, not protocol code.** `deepbook_margin`'s
  bundled tests declare a test-only extension of `pyth::price_info` in *their*
  tests directory, but the CLI compiles a dependency's tests **without applying
  the dependency's cross-package extensions**, so the suite fails with an
  unbound `new_price_info_object_for_test`. Root-package extensions *are*
  applied graph-wide, so the shim re-declares it here (verbatim), which is also
  why `pyth = "0xabf837…"` appears in our `[addresses]` (the same value pyth's
  own manifest assigns — needed only so the shim can name the module).
  `#[test_only]` code never enters published bytecode.
- **`deepbook_margin` resolves via MVR** (`@deepbook/margin-trading/13`) — the
  `mvr` binary must be on PATH for a fresh resolution; `Move.lock` pins the
  revs after that. Version 13 specifically: it is the newest MVR version that
  ships git source (see ARCHITECTURE §13).
- **Upgrade discipline.** The package is live on testnet, so published struct
  layouts and `public` function signatures are frozen. Everything added since
  the last publish is additive (new modules, new functions, new structs,
  dynamic-field state) — keep it that way: extend via dynamic fields
  (`VolState`, `RehypoConfig`, `MarginCallKey` are the precedents), never by
  editing a published struct.

## Abort codes

All aborts use `errors.move` getters — globally unique, grouped by area
(auth 0–9, governance 10–19, treasury 20–29 incl. `EBelowLiquidityFloor` 24,
traders 30–39, registry 40–49, OTC seams 50–59, oracle 60–69, forward 70–89
incl. `ECureWindowActive` 77 / `EExpiredUseClose` 78, rfq 90–109 incl.
`ECrossedQuote` 105 / `EAlreadyQuoted` 106 / `EOverBucket` 107, direct
110–119). A failed tx's code names the failure precisely.
