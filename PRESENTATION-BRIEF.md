# Demo-day presentation brief — study material

Deep background for the six things the judges ask for, plus hostile-Q&A preparation
and a facts cheat-sheet. Protocol-specific content is grounded in this repo
(WHITEPAPER.md, RISK-RESPONSIVE-REHYPOTHECATION.md, ARCHITECTURE.md, the code, and the
live smokes run 2026-07-10/11). Market and ecosystem figures were verified against
external sources on 2026-07-12 (web research; full link list in the final section) —
each carries its source inline. Event context: Sui Overflow's demo day is judged by a
large expert panel (the 2024 edition had 47 judges), and Fullmetal sits squarely on two
official tracks: *financial primitives/payment rails* and the *DeepBook-powered
trading & liquidity* specialized track — say so in the open.

---

## 0. The spine of the story (memorize this shape, not words)

> OTC derivatives run on collateral that is deliberately kept idle by a stack of
> intermediaries. The one time finance let collateral be re-used without limits —
> pre-2008 London — the chain of re-pledging collapsed and destroyed trillions in
> effective collateral. So the industry chose idleness over velocity. **On a chain with
> programmable custody you don't have to choose**: margin can earn, because the system
> can *prove* it is still there and *force* it back the moment risk spikes. Fullmetal is
> that machine: pooled cross-margined treasuries, bilateral contracts as shared objects,
> firm collateral-backed quotes, and a permissionless risk loop that recalls collateral
> on a volatility trigger and redeposits when calm returns — with re-pledging made
> impossible by the type system, not by a covenant.

Every section of the pitch is one clause of that paragraph expanded.

---

## 1. The problem (and the numbers behind it)

### 1.1 Market size and structure (verified, latest prints)
- **OTC derivatives outstanding: $846T notional at end-June 2025 — up 16% yoy, the
  largest jump since 2008** (BIS OTC derivatives statistics, Dec 2025 release). Gross
  market value — the honest "money at risk" figure — **$21.8T, up 29% yoy**. The market
  is not just huge; it is *re-accelerating*.
- **Margin in motion: a record $1.6T** collected by the leading dealers for non-cleared
  exposures at year-end 2025, **+9.3% yoy** — **$524.7B of initial margin + $1.0T of
  variation margin** (ISDA Margin Survey, Apr 2026). Cleared IM at major CCPs adds
  another **$423.5B**. This is the pool Fullmetal targets: posted, encumbered, mostly
  unremunerated collateral — and it grows ~10% a year.
- **Uncleared Margin Rules (UMR) phases 5–6** (2021–22) dragged *thousands* of smaller
  buy-side firms into mandatory IM exchange. They feel the pain worst: they pay the
  full custody/tri-party stack without a dealer's scale.

### 1.2 Why the collateral is idle — the stack
A bilateral trade today transits: executing broker → prime broker → (if cleared) clearing
member → CCP → custodian/tri-party agent (BNY, JPMorgan, Euroclear, Clearstream). Each
layer: fees, minimum-transfer thresholds, T+1 margin-call cycles, dispute workflows,
reconciliation. Segregated IM typically sits in cash/T-bill share classes where the
*custodian and manager* capture most of the spread. The poster earns ≈ 0 on capital that
exists purely to make them safer.

### 1.3 Why TradFi can't just "make it earn" — the 2008 memory
This is the intellectual core of the pitch; the whitepaper §1 and risk doc §2 carry it:
- The **only quantitative re-use rule TradFi ever wrote is SEC 15c3-3**: a broker may
  re-use client collateral up to **140% of the client's debit balance**. A hard linear
  cap — evidence that re-use is *valuable* and *feared* in equal measure.
- **Pre-2008 London had no cap.** Collateral was re-pledged in chains — **churn ≈ 4×**
  on hedge-fund collateral. When Lehman fell, the chain unwound: an estimated
  **$4–5T contraction in effective collateral** (Singh & Aitken, IMF WP/10/172 and
  WP/11/256 — cited in your risk doc §9 with links).
- Post-crisis, the system chose **idleness** (segregation, no re-hypothecation of IM
  under UMR) because *nobody could verify where collateral was at any instant*.

**The chain changes exactly that one fact.** Custody is programmable and state is
shared: you can verify the collateral's location every block, cap velocity at 1 in the
type system, and make the recall permissionless. That's the wedge.

### 1.4 Procyclicality — margin calls as the crisis engine (color for Q&A)
- **March 2020 "dash for cash"**: CCP margin calls spiked globally (BIS/FSB studies put
  the IM increase in the hundreds of billions ★), forcing asset fire-sales.
- **UK LDI, Sept 2022**: gilt-collateral margin spiral forced the Bank of England into a
  £65B emergency purchase program ★. Margin procyclicality is now a named regulatory
  workstream (EMIR Art. 28 "anti-procyclicality" tools — which your trigger literally
  implements: buffer, floor, no big step changes).
- **Archegos, 2021**: ≈ $10B of bank losses ★ from *bilateral opacity* — five prime
  brokers each saw one slice. On-chain bilateral contracts with a shared risk oracle are
  the structural answer to "nobody saw the whole book."

### 1.5 The crypto-native version of the problem
- Post-FTX, institutional desks won't park collateral in an exchange omnibus account.
  Bilateral OTC (the Paradigm-style workflow) runs on **reputational** quote firmness
  and bilateral credit lines, or full prefunding — the same idle-capital problem plus
  counterparty risk.
- On-chain USDC earns 4–5.5% in blue-chip lending venues **right now** (your app reads
  it live). Every dollar of prefunded OTC margin not earning that is a measurable cost.

### 1.6 The industry is already converging on this — externally verified tailwinds
This is your strongest new material: you are not claiming a trend, you are riding one
that regulators, BlackRock, and Europe's market infrastructure all joined in the last
~18 months:

- **CFTC, Dec 8 2025**: issued guidance on **tokenized collateral** and launched a
  digital-asset pilot allowing BTC/ETH/**USDC** as derivatives collateral — the US
  derivatives regulator is formally moving margin on-chain.
- **BlackRock's BUIDL** (~$2.5–2.9B, >40% of the tokenized-Treasury market) is now
  accepted as **derivatives margin collateral** at Deribit, Binance, and Crypto.com
  (Nov 2025). TradFi's best current answer to idle margin is a *yield-bearing token
  you can post*.
- **Eurex Clearing went live (June 30, 2025) with a DLT-based collateral-mobilization
  service built with HQLAx/Clearstream**; **Euroclear + Digital Asset** launched a
  tokenized-collateral-mobility initiative on Canton (Feb 2025); the **ECB** plans
  DLT settlement in central-bank money with a pilot by Q3 2026.

**The positioning sentence this buys you:** *"CFTC pilots, BUIDL-as-margin, Eurex's
DLT collateral service — the whole industry agrees collateral should be tokenized,
yield-bearing, and mobile. But they are bolting DLT onto the old tri-party stack.
We built the destination: the margining, the yield, and the risk response in one
protocol, where a volatility trigger — not a custodian's business hours — moves the
collateral."*

**Slide-ready formulation of the problem:** *"Trillions in derivatives collateral sit
idle behind up to ten intermediaries — because the last time finance let collateral
move, it couldn't prove where it was. We make collateral provable, so it can move."*

---

## 2. Solution & value proposition

### 2.1 What Fullmetal is (four claims, each mapped to code)
| Claim | Mechanism (say it in one breath) | Where |
|---|---|---|
| One pooled, cross-margined treasury per desk | IM is an **accounting fence** (`reserved`), never a transfer — one pool backs every position simultaneously | `institution.move` |
| Idle margin earns | Surplus above the on-chain liquidity floor is supplied to DeepBook margin / Suilend / Navi; **the institution object itself custodies the receipts** | `rehypo.move`, `rehypo_router.move` |
| Risk response is permissionless | EWMA volatility trigger latches on-chain; **anyone** can crank the recall — no operator, no 3am admin key | `oracle.move`, `recall_on_trigger` |
| 2008 is excluded by construction | Receipts are never re-pledged — **collateral velocity capped at 1 by the type system**, not a covenant | receipts held as dynamic fields; no re-pledge path exists |

### 2.2 The value proposition, quantified
- **Yield on posted margin**: at the live 4–5.5% USDC supply APRs, a desk posting $100M
  of IM recovers **$4–5.5M/year** that today goes to the custody stack. This is the
  number to lead with — it's measurable and nobody disputes it.
- **Capital efficiency**: 5% IM ⇒ up to 20× notional; maintenance = 70% of IM; and
  because margin is pooled, a desk's buffer absorbs shocks across its whole book
  (the demo shows a breached position *surviving* because the pool covers it).
- **Speed**: variation-margin settlement and margin-call cure are on-chain transactions
  with sub-second finality — versus T+1 calls, MTAs, and disputes.
- **Counterparty safety**: no omnibus custody. Your collateral never leaves an object
  you control; the counterparty's claim is enforced by code (settlement is
  **pause-exempt** — a loser cannot self-pause to repudiate losses).
- **Firm liquidity**: RFQ quotes are **IM-bonded on-chain with no last look** — a quote
  *is* a posted bond. In TradFi and Paradigm-style crypto RFQ, firmness is reputational.
- **Auditability**: BCS-stable event stream; a regulator/auditor can reconstruct every
  reservation, settlement, recall, and liquidation.

### 2.3 Per-stakeholder framing (useful for the "who cares" moment)
- **Treasurer/CIO**: idle IM becomes a yield line; floor + caps give a written,
  enforced liquidity policy.
- **Trader**: more leverage per dollar, instant onboarding of new counterparties
  (handle → institution), firm quotes.
- **Risk officer**: the control loop is *inspectable* — EWMA state, latch, floor, venue
  caps all on-chain; margin calls have due process (cure window) instead of
  wick-picking liquidations.
- **Auditor/regulator**: velocity-capped rehypothecation with a full event trail — the
  transparency 2008 lacked.

---

## 3. Technical implementation (deep-dive ammunition)

### 3.1 The architecture in three sentences
Thirteen Move 2024 modules in one package. An `Institution<C>` shared object per desk
holds one `Balance<C>` treasury plus four numbers — liquid **T**, reserved **R**,
deployed **Y**, maintenance **M** — and every protocol action is an invariant over them
(equity E = T + Y; available A = E − R; withdrawals need both `≤ A` *economic* and
`≤ T` *physical*). Bilateral contracts, RFQs, and offers are their own shared objects;
value moves only through hot-potato tickets that cannot be dropped.

### 3.2 The six mechanisms worth explaining on stage (pick 2–3)
1. **The margin fence.** `reserve_margin` moves no coins — it raises R and records a
   `ContractRef`. Cross-margining isn't a feature bolted on; it's the *absence* of
   per-position silos.
2. **Hot potatoes = atomic obligations.** `SettlementTicket` and the rehypo
   supply/recall tickets have **no abilities** (no drop/store/copy): the same
   transaction MUST complete the transfer or everything reverts. This is Sui's linear
   type system doing the job that reentrancy guards and approval hygiene do (badly) on
   EVM.
3. **The RFQ re-key.** A maker's quote firm-reserves IM at quote time keyed by quote id;
   `accept_quote` re-keys that reservation onto the fresh contract — **the maker never
   co-signs, so there is no last look and no fade**, yet its funds were never moved.
4. **The breach crank with due process.** `settle_on_breach` is permissionless: the
   moment unrealized loss eats the 30%-of-IM buffer, anyone can force settlement. If the
   pool has liquid funds → pay and survive (cross-margin grace). If funds are deployed →
   an on-chain **margin call** with a cure window; only a call that ages uncured
   liquidates. A one-print wick that mean-reverts can never kill a position.
5. **The EWMA trigger.** σ² ← λσ² + (1−λ)r², integer math, one multiply-add per print.
   Two latches (z-score shock > 4σ **or** absolute σ ceiling — BoE research shows level
   and shock controls fail in different dimensions, so both). Release is asymmetric:
   σ < 0.7·ceiling AND 3 consecutive calm prints (EMIR Art. 28's "no disruptive step
   changes", literally implemented). Emergent property, captured in tests: a bigger
   shock leaves σ elevated longer, so cool-down extends automatically.
6. **The liquidity floor + router.** T ≥ max(O_stress, 25%·R) is asserted **on-chain in
   the deploy path** — an adversarial keeper can propose a bad allocation but never an
   unsafe one. Venue receipts (SupplierCap / CToken / AccountCap) live in dynamic-field
   slots behind hot-potato tickets; per-venue caps and weights are admin-tunable without
   struct migration.

### 3.3 Battle scars (judges love these — they signal real engineering)
- **Two confirmed attack classes found in self-audit and fixed with regression tests**:
  (a) per-crank funding over-collection — funding now accrues pro-rata in elapsed time,
  so any crank sequence telescopes to the exact single charge; (b) wick-picked terminal
  liquidation — the cadence `settle` path was funneled through the same
  pay/call/liquidate core so the cure window can't be bypassed.
- **devInspect lies about visibility**: Navi's `create_account_cap` is friend-only and
  *passes* devInspect; only `dryRunTransactionBlock` caught it. All venue validations
  are dry-run-grade.
- **There is exactly one Pyth and one Wormhole on Sui** — Suilend/Navi link *mirrors* of
  the same audited package. This finding shaped the venue layer: typed adapters where
  source linking is clean (DeepBook live, Suilend buildable), PTB adapter where it isn't
  (Navi).
- **The testnet fullnode dropped JSON-RPC the week of the demo** (gRPC-only now) — found
  in audit, reads migrated to alternate endpoints with env-based failover. (Good answer
  to "what breaks in production?": infra churn, and we've already survived some.)

### 3.4 Verification story (memorize the numbers)
- **40/40 Move unit tests** — lifecycle, RFQ/direct/two-way economics, cross-margin
  crank (grace, margin-call-then-liquidate, funding telescoping), risk layer
  (hand-computed EWMA variance traces, hysteresis, floor boundary, ticket round-trips).
- **Live testnet smokes** (scripts, re-runnable): the full EWMA loop — latch at the
  designed tick, recall, 3-print release, redeposit (`vol-smoke.ts`); and the full
  margin-call drill through the app's own API — call recorded while funds deployed,
  cure recalls + pays, position survives, latch auto-releases (`drill-smoke.ts`).
- **Mainnet validations**: Suilend supply→redeem round-trip in one PTB (net
  −0.000001 USDC — share-rounding dust); Navi oracle-refresh→create→deposit→withdraw in
  one PTB. Live APR/utilization/withdrawable reads for all three venues power the app.
- **Audited components**: OpenZeppelin Move math (SD29x9 signed fixed-point,
  u128 mul_div with explicit rounding), pinned to the audited v1.2.0 tag.

### 3.5 What's real vs simulated in the demo (SAY THIS UNPROMPTED)
| Layer | Status on stage |
|---|---|
| Institution, treasury, RFQ + firm quotes + accept, forwards, cross-margin fences | **Real, Sui testnet** — every action is a transaction with an explorer link |
| Oracle prints, EWMA latch/release, permissionless recall, margin call + cure + liquidation | **Real, testnet** (cure window set to 90s for the stage; production target ~10 min — an internal constant, retunable) |
| DeepBook margin pool rehypothecation | **Real, testnet** (the actual DeepBook margin package) |
| Suilend / Navi | **Balances simulated in the UI** (badged SIM), accruing at **live mainnet APRs**; the underlying supply/withdraw PTBs are **validated against live mainnet under dry-run** |
| Gas | Users pay none — Enoki-sponsored zkLogin transactions |

Volunteering this table builds more credibility than any claim. The one-liner:
*"Everything you'll watch is a real transaction on testnet; the two mainnet-only venues
are simulated in the UI at their live mainnet rates, and their exact transaction shapes
are validated against mainnet under dry-run."*

---

## 4. Path to production & go-to-market

### 4.1 Engineering path (whitepaper §9 — "the honest gap list")
Framing to use: *"None of these are research problems; they're engineering weeks."*
1. **Oracle**: today one KeeperCap pushes marks. Production = **Pyth as the mark source**
   (dependency already present transitively) + staleness/deviation-band asserts; the
   EWMA/trigger layer sits unchanged above whichever mark source; multiple keepers.
2. **Key discipline**: split ProtocolCap / OracleAdminCap / KeeperCap / UpgradeCap to
   separate keys; multisig + timelock on upgrades and witness allowlisting; per-tenant
   m-of-n AdminCaps.
3. **Adapter witnesses**: allowlist venue adapters exactly like OTC witnesses (mechanism
   already exists in `protocol.move`) so only audited adapters can confirm receipts.
4. **Keeper daemon + liquidation incentive**: a bounty makes third-party cranking
   self-funding; daemon watches `mm_breached` across books.
5. **Third-party audit, CI, key ceremony, incident runbook** — institutional table
   stakes.

### 4.2 Calibration path (whitepaper §11 — the backtest plan)
Deterministic replay of stress windows (Nov 2022 FTX, Mar 2023 USDC depeg, Jul 2023
Curve, Apr 2026 Aave USDT pin) reusing **the exact integer EWMA arithmetic from the Move
module**, so backtest and chain compute identical σ. Sweep the parameter frontier
(z*, σ-ceiling, floor fraction), plot safety-vs-yield Pareto, ship the knee as
`RehypoConfig` defaults. Pass criterion: floor holds with no manual intervention in
≥ 99% of adversarial paths. **Venue-history recording can start now** — `/api/rates`
snapshots via cron.

### 4.3 Mainnet sequencing
1. Audit + backtest-calibrated parameters →
2. Mainnet deploy with **DeepBook margin (already live on mainnet) as venue #1**, capped
   pilot notional →
3. Typed Suilend adapter package (build already proven), then Navi PTB adapter →
4. Privacy Phase B (Seal sealed-bid RFQ — quotes already post IM, so the classic
   commit-reveal griefing problem is pre-solved; only encryption is missing) →
5. Cross-margin across derivative types (options next to forwards/perps — the M
   aggregation is already SIMM-shaped).

### 4.4 Go-to-market
- **Beachhead**: crypto-native OTC/market-making desks (the demo's Cumberland / Galaxy /
  Wintermute archetypes are the literal ICP). They already run bilateral books, hold
  USDC treasuries, have on-chain ops teams, and are yield-sensitive. **The beachhead is
  measurable**: Paradigm alone connects 700–1,000+ institutional counterparties doing
  ~$10B/month of crypto-derivatives RFQ flow (20–30% of global crypto options volume) —
  that population already trades exactly this way; we add the settlement, margining,
  and yield layer their workflow lacks. Sales motion: 2–3 **design partners** in a
  capped-notional pilot (e.g. $1–5M per desk), co-designing the maker workflow.
- **Second ring**: funds/family offices and DAO/protocol treasuries that want derivative
  exposure or hedges without CEX custody; UMR-phase-6-sized TradFi-adjacent firms later,
  through regulated custodians (Copper/Fireblocks-style MPC holding the caps).
- **Maker network**: seed with fee rebates + the pitch that *firm quotes cost only
  yield* (reserved IM keeps earning until accepted... note: reserved IM stays in the
  pool and the pool's surplus earns — makers aren't dead-capital-locked the way a CEX
  quote bond is).
- **Distribution wedge**: meet desks where they quote (chat-based RFQ UX later, API
  first); the SPCX demo narrative (pre-IPO synthetics) shows the venue-less-underlying
  story, but production launch underlyings are crypto majors + FX (see legal Q below).
- **Metrics to show PMF when asked**: signed design-partner LOIs, testnet desks
  onboarded, notional simulated, maker response times, yield captured per $ posted.

---

## 5. Target users & product-market fit

### 5.1 Segmentation (with the adoption driver per segment)
| Segment | Pain today | Why they adopt |
|---|---|---|
| Crypto-native OTC desks / MMs | prefunded or credit-line bilateral books; idle USDC margin; post-FTX custody fear | yield on IM (measurable), firm on-chain quotes, no omnibus custody |
| Mid-size funds / family offices | no PB access; CEX custody risk; capital inefficiency | 20× with 5% IM, pooled margin, instant onboarding |
| DAO / protocol treasuries | hedging without an off-chain counterparty | fully on-chain lifecycle + auditability |
| TradFi desks (later) | UMR costs; collateral drag; want digital-asset exposure | regulated-custodian integration; the yield + transparency story |

### 5.2 Why they'd actually switch (the honest version)
The adoption equation is: **(yield on IM + capital efficiency + custody safety) must
beat (key-management burden + legal novelty + protocol risk)**. That's why GTM is
capped pilots with crypto-native desks first — for them the right side of the equation
is already near zero, and the left side is their own P&L. Every production-path item in
§4.1 shrinks the right side for the next ring of adopters.

### 5.3 Adoption frictions & your mitigation lines
- *Key management*: multisig/MPC AdminCaps; zkLogin lowers operator friction; caps are
  revocable (epoch mass-revoke exists today).
- *Legal enforceability*: map on-chain terms as an annex to an ISDA-style master
  agreement; arbitration clause; start with counterparties who accept code-as-recourse.
- *Oracle trust*: Pyth path + deviation guards (§4.1); the trigger layer is
  mark-source-agnostic.
- *Liquidity cold start*: RFQ needs 3–5 makers, not an order book's depth — that's the
  point of choosing RFQ microstructure for OTC.
- *Venue/USDC tail risk*: next section's Q&A answers.

### 5.4 Competitive landscape (externally verified — know where you sit)
| Player | What they are | Why we're different |
|---|---|---|
| **Paradigm** (~$10B/mo RFQ, 700–1,000+ institutions) | The dominant crypto-OTC *workflow*: RFQ chat/API, execution routed to venues | Execution-only — firmness is reputational, settlement/custody/margining live elsewhere. We are the settlement + collateral + risk layer under exactly that workflow, with IM-bonded quotes and no last look |
| **Hyperliquid** (~70% of on-chain perps; $633B volume Q1 2026; ~$9B OI; $1B revenue) | Proof that on-chain derivatives work at institutional scale | A standardized central-orderbook exchange. Bespoke bilateral terms (tenor, funding, counterparty, size buckets) don't fit an orderbook — the $846T OTC market exists *because* of that. Complementary, not competitive |
| **Tokenized-stock platforms** (Robinhood's SPV-wrapped OpenAI/SpaceX tokens; ~$1B tokenized-stock market, +128% H2 2025) | Retail synthetic exposure to pre-IPO names | SPV wrappers transfer beneficial exposure and triggered issuer disavowal (OpenAI). Bilateral cash-settled forwards between eligible institutions transfer *no equity* — the demand signal without the wrapper problem |
| **HQLAx / Eurex / Euroclear-Canton** (DLT collateral mobility, live 2025) | TradFi's own collateral-velocity fix | They mobilize collateral *records* across the same custodial stack, for banks. We replace the stack for the crypto-native segment those rails don't serve |
| **CCPs** | Mutualized clearing for standardized products | Membership-gated, default-fund-mutualized, standardized-only. We deliver CCP-grade automation (margining, calls, liquidation) on bilateral bespoke terms |

**The gap sentence:** *"Execution networks have no margining; exchanges have no bespoke
terms; TradFi DLT pilots have no crypto-native users; CCPs have no bilateral products.
On-chain bilateral OTC with productive collateral is an empty quadrant — that's the one
we're standing in."*

---

## 6. Monetization & sustainability

### 6.1 Revenue lines (in order of alignment)
1. **Rehypothecation yield spread** — protocol retains 10–20% of venue yield routed
   through the router. Perfectly aligned: the protocol earns only when users earn.
2. **Contract fees** — 0.5–2 bps of notional at open and/or a small settlement fee per
   MTM cycle (TradFi pays multiples of this at every stack layer).
3. **RFQ economics** — taker-side bps; maker rebates to seed the panel (classic venue
   economics).
4. **Institution SaaS** — seats, risk console (σ-trace, venue panel, treasury
   waterfall — the whitepaper §10 visualization plan), compliance/audit exports, API.
5. **Keeper/liquidation bounties** — makes protocol operations self-funding rather than
   a cost center.

### 6.2 Unit-economics sketch (defensible on a whiteboard)
20 pilot desks × $10M average posted collateral = $200M TVL-equivalent. At 5% venue
yield: $10M/yr earned user-side; a 15% spread = **$1.5M/yr protocol revenue before any
trading fees**. Trading fees at 1bp on 10× annual collateral turnover ≈ another $2M.
Sustainability does **not** require a token; a token (governance / maker incentives) is
optional and later — say this proactively, it reads as discipline.

### 6.3 Roadmap (the one-slide version — from whitepaper §12)
- **A — hardening** (done: breach crank, two-way RFQ; next: Pyth marks + guards,
  adapter witnesses, keeper daemon + liquidation incentive, key split).
- **B — risk automation**: keeper allocation optimizer over the venue adapters,
  backtest-calibrated parameters, risk console.
- **C — privacy**: Seal sealed-bid RFQ with on-chain winner decryption; encrypted
  activity logs to Walrus for auditors/parent institutions.
- **D — scale**: real maker network, membership binding, options in the same
  cross-margin pool, AI venue-risk monitor.

---

## 7. Why Sui (this is your strongest technical section — it's all load-bearing)

Structure the answer as: *"Four Sui primitives aren't conveniences — the protocol's
safety claims are literally built out of them."*

1. **Object model = the domain model.** An OTC contract IS a shared object; an
   institution IS a shared custody object; roles ARE owned capability objects
   (revocable, epoch-bumpable). No global contract state, no account-key mapping — the
   thing you reason about legally is the thing that exists on chain.
2. **Linear types (hot potatoes) = atomic obligations.** Structs with no abilities
   cannot be dropped, stored, or copied — so a settlement debit *must* reach the payee
   in the same transaction, and a treasury debit for rehypothecation *must* end in a
   stored receipt. This is the mechanism that makes "collateral velocity capped at 1"
   and "atomic inter-institution settlement" true **by construction**. EVM's equivalents
   are reentrancy guards, allowances, and prayer.
3. **PTBs = cross-protocol atomicity without glue contracts.** The Suilend round-trip
   (supply → redeem, net −0.000001 USDC) and the Navi flow (oracle refresh → create
   account → deposit → withdraw) each run in ONE transaction *with no deployed adapter
   code*. On EVM each would be a custom audited router contract.
4. **Upgrade discipline institutions can live with.** Published struct layouts and
   signatures are frozen; evolution is additive via dynamic fields (`VolState`,
   `RehypoConfig`, `MarginCallKey` — all shipped this way, upgrade proven live on
   2026-07-10). Institutions get contract stability *and* an evolvable protocol.
5. **Mysticeti finality ≈ 390–400 ms** (measured network-wide, June 2026 — roughly half
   of Solana's ~800 ms), with the network sustaining 800+ real TPS — margin calls,
   cures, and recalls land in under a second; per-object parallelism means unrelated
   desks never contend.
6. **zkLogin + sponsored transactions (Enoki)** — a trading desk onboards with Google
   SSO and pays zero gas. The demo's entire flow is gasless; nobody installs a wallet.
   External validation: major fintechs adopted zkLogin in 2026 to put tokenized
   equities in front of retail users — the same primitive, institutional-grade.
7. **The ecosystem is the venue set — and it matured this year**: DeepBook (native
   CLOB) launched **v3 margin trading in Q2 2026** on the margin-pool system live
   since March 2025 — *those margin pools are literally Fullmetal's venue #1*, on both
   testnet and mainnet; Suilend and Navi complete the lending trio; **native USDC**
   is the settlement asset; MVR resolves the dependency graph; **one Pyth + one
   Wormhole deployment** keeps the oracle graph clean (your measured finding).
8. **Institutions are arriving on Sui specifically**: CME listed SUI futures (only the
   fourth L1 to reach CME's regulated derivatives market); Bitwise and Canary have
   spot-SUI ETF filings; Sui DeFi TVL peaked at ~$2.6B. The chain your counterparties'
   risk committees will ask about is answerable.
9. Honest trade-off if pressed: Ethereum has deeper institutional custody support today;
   Sui's advantage is that the *protocol-shaped* primitives above don't exist there.
   You chose the chain where the safety property is a type-system fact.

---

## 8. Q&A preparation — the hard questions, with answers

**Q. Rehypothecation caused 2008. You're rebuilding it. Why is this safe?**
A. 2008's failure was *unbounded velocity in the dark* — collateral re-pledged in chains
(churn ≈ 4×) that nobody could observe. Here: (1) velocity is capped at 1 — receipts sit
in the institution object and there is no code path to re-pledge them; (2) everything is
observable every block; (3) an on-chain floor keeps liquid treasury ≥ max(stress
estimate, 25% of reserved IM) — deploys that would breach it abort; (4) the recall is
permissionless — no operator has to act. We kept the *value* of re-use (yield) and
deleted its *mechanism of failure* (opaque chains).

**Q. Your oracle is one keeper key. That's the whole system's trust anchor.**
A. Correct, and it's #1 on our production gap list. The mark source becomes Pyth (the
dependency is already in our build graph) with staleness and deviation-band asserts;
the EWMA/trigger layer is mark-source-agnostic and stays; keepers become multiple. Note
the *risk response* is already trust-minimized — the recall is permissionless and the
floor is chain-enforced; the keeper can propose a suboptimal allocation but never an
unsafe one.

**Q. What if a venue (Suilend/Navi) is exploited or gated while your money is in it?**
A. Priced, not hand-waved. Entry caps: position ≤ 25% of the venue's *withdrawable*
liquidity plus admin absolute caps — exit liquidity is controlled at entry, because the
record (Aave USDT pinned >99% utilization for 135 hours; Curve/Fraxlend repayments
withdrawn instantly at 100%) shows rate models don't save you in a common-factor panic.
Cross-venue correlation is set to 0.8 — three venues on one chain are yield
diversification, not tail-risk diversification, and the math grants them almost no
credit. And the floor keeps 25%+ liquid at all times regardless.

**Q. USDC depegs?**
A. Same machinery, measured case in our doc (Mar 2023: Aave froze markets, $300k
insolvencies, 4 days to normalize). Our answer is the floor (always-liquid buffer), the
trigger (a depeg print latches instantly), and venue caps. Longer-term: multi-collateral
support is a config change — collateral is a type parameter `C` through the whole stack.

**Q. Why would a real desk put $10M into a hackathon protocol?**
A. They wouldn't, and we're not asking them to. Path: third-party audit + backtest
calibration + capped design-partner pilots ($1–5M) + key ceremony/multisig + the fact
that custody never leaves the desk's own object. The pitch to a pilot desk is not
"trust us," it's "verify the invariants — here are the 40 tests and the live drill."

**Q. Is this legal? You're offering synthetic SpaceX exposure.**
A. SPCX is a demo underlying chosen for the narrative — and the demand is externally
proven: Robinhood's SPV-wrapped SpaceX/OpenAI tokens (June 2025) drove a frenzy, a
~$1B tokenized-stock market growing 128% in a half… and an immediate public disavowal
from OpenAI, because wrappers that transfer beneficial ownership need issuer consent.
That's exactly the wedge for our structure: **bilateral, cash-settled forwards between
eligible institutions transfer no equity at all** — the classic derivatives answer to
restricted underlyings. Launch underlyings are still crypto majors and FX; structure:
ISDA-style master agreement with on-chain terms as annex, jurisdiction-appropriate
entity, non-US-persons perimeter first. The protocol is infrastructure; the desks are
the counterparties.

**Q. Cold start — where do makers come from?**
A. RFQ microstructure needs a *panel*, not a book: 3–5 makers is a functioning market
(SEF data shows customers ping ~4 dealers even when dozens are available). We seed with
fee rebates and the structural pitch: quoting costs only foregone yield, since reserved
IM stays in the maker's own earning pool, and firm quotes can't be last-looked so
winners actually win.

**Q. What stops quote-fade or RFQ front-running?**
A. Fade: impossible — the maker's IM is reserved at quote time and re-keyed at accept;
no co-signature, no last look. Information leakage: the two-way RFQ module (built,
tested) removes direction entirely (makers must quote bid AND ask), enforces single-shot
quoting (no tick-undercutting), buckets size, and diets the events to ids+expiries.
Phase B seals the prices themselves (Seal threshold encryption, on-chain winner
decryption) — and our quotes already post IM, which pre-solves commit-reveal's
non-reveal-griefing problem.

**Q. Can someone grief desks by cranking / triggering recalls?**
A. Cranking a healthy contract aborts. A real breach cranked early just settles — that's
the design. Wick-picking is closed: insolvency triggers a margin call with a cure
window, and only a still-uncovered aged call liquidates; the two attack classes we found
in self-audit (per-crank funding over-billing, cure-window bypass via the cadence path)
are fixed with regression tests. A malicious *oracle* print forcing a recall costs the
desk only foregone yield — recall is the safe direction. That asymmetry is deliberate.

**Q. Cross-margining: is it real netting?**
A. Honest answer: reservation is a **sum** today; the *benefit* shown is pooled-buffer
grace (a breached position survives if the pool covers it) and zero per-position silos.
SIMM-style correlation netting across underlyings is deferred and the aggregation shape
is already SIMM's (the M denominator exists). Worth noting DeepBook margin itself
forbids multi-pool cross-margin — real netting is genuinely hard, and we chose to ship
the enforceable part first.

**Q. Why RFQ and not an order book? Hyperliquid already won on-chain derivatives.**
A. Hyperliquid winning is evidence *for* us, not against: it proves institutions will
run derivatives on-chain at scale ($633B in Q1 2026, ~$9B open interest) — for
**standardized, exchange-listed** products. OTC is the other, larger market ($846T
notional): bespoke size, tenor, funding, named counterparty credit. That's RFQ-shaped —
it's how the whole OTC market trades today, and how the crypto-institutional segment
already behaves (Paradigm: ~$10B/month over RFQ). DeepBook the CLOB is our *yield venue
and price infrastructure*, not the trading model. AMMs can't quote bespoke bilateral
terms at all.

**Q. What's the moat?**
A. Three compounding layers: (1) mechanism design — firm IM-bonded quotes, re-key
accept, breach crank with due process, velocity-1 rehypothecation: each is small, the
composed system is months of adversarial iteration (two attack classes already found
and closed); (2) the risk layer — a fully-sourced, backtestable control loop (SIMM +
Basel LCR + EMIR + Gauntlet/Chaos methods) that institutions can diligence line-by-line;
(3) network — maker panels and cross-margined books are sticky once capital is pooled.

**Q. What happens if Sui halts?**
A. Chain liveness is venue liveness — we price it (the Solend/FTX case: "oracle updates
intermittent, withdrawals impacted" is in our sources) via the recall-latency term:
buffers scale with √t_recall, and the floor's 25% is unconditional — the desk always
holds liquid margin against calls even with the chain degraded. Multi-chain is a
long-term option; the honest near answer is "we hold a bigger liquid buffer than anyone
whose recall is instant-by-assumption."

**Q. How is this different from Paradigm / Hashflow / a CCP?**
A. Paradigm: RFQ workflow, off-chain, reputational firmness, no margin protocol — we're
the settlement + collateral layer under that workflow, with bonded quotes. Hashflow/
off-chain-quote designs: remove leakage but trust a quoting service's liveness; we keep
quotes on-chain (Phase B seals them). CCP: mutualized default fund, membership gates,
standardized products — we deliver CCP-grade automation (margining, calls, liquidation)
on *bilateral, bespoke* terms with no mutualization. Different point in the design
space, and the bigger one by notional.

**Q. Your cure window is 90 seconds?**
A. Demo calibration so a live audience can watch a full call→cure cycle; production
target is ~10 minutes (it's one internal constant; both values are in the docs). Same
for the EWMA λ=0.60 — print cadence on stage is ~1.2s, so the half-life is scaled to
prints; production runs λ≈0.94 on real cadence. Parameters are admin-retunable live
(`retune_vol`) without redeploying — that itself is the EMIR-style governance story.

**Q. Gas/scaling costs of per-print oracle pushes?**
A. Pennies on Sui, and production marks come from Pyth (pull-based, amortized) with the
EWMA update as one integer multiply-add. Per-object parallelism means desks don't
contend; only same-contract settlement serializes.

**Q. Who are you and why will you win?** — your slot: solo-built, full-stack (Move
protocol + risk research + frontend), self-audited with found-and-fixed attack classes,
shipped an upgrade + live drill the week of the demo. The risk doc's citation discipline
is the differentiator to flaunt: every parameter traces to a primary source.

---

## 9. Demo-day facts cheat-sheet (numbers you must not fumble)

**Protocol constants (as deployed):**
- IM: negotiated, UI floor max($1, 5% × notional) ⇒ ≤ 20× leverage. MM = 70% of IM.
  Breach buffer = 30% of IM.
- Cure window: **90s on stage / ~10 min production target**.
- Liquidity floor: T ≥ max(O_stress, **25% of reserved IM**) — enforced on-chain in the
  deploy path.
- EWMA (SPCX demo feed): seed σ 150 bps/print, **λ = 0.60** (demo cadence; prod ≈ 0.94),
  shock latch z* = 4σ, regime ceiling 800 bps/print, release band < 560 bps (0.7 × ceil)
  × **3 consecutive prints**. Legacy jump trigger (±15%) still active beneath.
- Live market ticker: continuous real on-chain prints (~1.5 s cadence); **💥 Crash**
  injects a −18…22% gap (latches at z ≫ 4σ), aftermath vol decays with a ~3-print
  half-life, release lands **~6–7 prints after the crash** (~15–20 s crash→redeposit);
  Monte-Carlo checked: false-latch ≈ 0.003%/print, crash always latches.
- Drill math: $100 desk, 1-SPCX contracts (IM $9.25 each), deploy ≥ $65 so liquid < $37
  (= the VM a −20% move owes) ⇒ margin call fires instead of instant pay.
- Tests: **40/40 Move**; live smokes passed 2026-07-10 (`vol-smoke.ts`,
  `drill-smoke.ts`).
- Current testnet package: `0xf8b57f09…635a4a` (additive upgrade over the original
  `0x3dfbfa52…`, published live during demo prep).

**Market numbers (verified 2026-07-12; sources in the final section):**
- **$846T** OTC notional (end-June 2025, +16% yoy — biggest jump since 2008) /
  **$21.8T** gross market value (+29%) — BIS.
- **$1.6T** margin collected by leading dealers for non-cleared exposures at year-end
  2025 (+9.3%): **$524.7B IM + $1.0T VM** — ISDA Margin Survey (Apr 2026). Cleared IM
  at CCPs: **$423.5B**.
- **CFTC (Dec 2025)**: tokenized-collateral guidance + BTC/ETH/USDC derivatives-
  collateral pilot. **BUIDL** (~$2.5–2.9B) accepted as margin at Deribit/Binance/
  Crypto.com. **Eurex×HQLAx** DLT collateral service live June 30, 2025.
- **Paradigm**: ~$10B/month institutional RFQ flow, 700–1,000+ counterparties, 20–30%
  of global crypto options volume. **Hyperliquid**: ~70% of on-chain perps, $633B
  Q1-2026 volume, ~$9B OI. **Tokenized stocks**: ~$1B market, +128% in H2 2025.
- **Sui**: Mysticeti finality ≈ 390–400 ms; 800+ sustained real TPS; DeFi TVL peak
  ~$2.6B; DeepBook v3 margin trading live (Q2 2026); CME SUI futures; Bitwise/Canary
  spot-ETF filings.
- SEC 15c3-3: 140%-of-debit re-use cap. Pre-2008 churn ≈ 4×; **$4–5T** effective-
  collateral contraction post-Lehman (Singh, IMF — cited with links in your risk doc §9).
- Aave USDT Apr 2026: 77.4% → ~100% utilization in 10h, pinned > 99% for **135 hours**.
- Live venue APRs: whatever the rates bar shows on the day (4–5.5% range) — quote the
  screen, not a memorized number.

---

## 10. Testnet or mainnet? (the definitive answer)

**You are running the demo on TESTNET.** Say it plainly if asked. The full statement:

> "The protocol and everything you're watching — institution, RFQ, contracts, margin
> calls, the DeepBook rehypothecation, the oracle trigger and recall — is live on Sui
> **testnet**; every action is a real transaction you can open in the explorer. Two of
> the three yield venues, Suilend and Navi, only exist on **mainnet** — so their
> balances in the collateral manager are **simulated in the UI at their live mainnet
> rates**, and we validated the exact supply-and-withdraw transactions against live
> mainnet under dry-run — proven executable, no funds moved. Nothing in this demo
> touches mainnet funds."

Mainnet's three roles in your demo, none of them live-execution: (1) live read-only
APR/utilization/liquidity data feeding the rates bar and venue cards; (2) the dry-run
validated Suilend/Navi round-trips you cite as integration proof; (3) the deployment
target of the production path (§4.3).

---

## 11. External sources (verified 2026-07-12)

**Market / problem**
- [BIS — OTC derivatives statistics at end-June 2025](https://www.bis.org/publ/otc_hy2512.htm) — $846T notional (+16%), $21.8T gross market value (+29%)
- [ISDA — Margin Survey year-end 2025](https://www.isda.org/2026/04/29/isda-margin-survey-shows-leading-derivatives-firms-collected-record-1-6-trillion-of-margin-in-2025) — record $1.6T (+9.3%): $524.7B IM + $1.0T VM; $423.5B cleared IM
- [ISDA — Key trends in OTC derivatives markets, H2 2025](https://www.isda.org/2026/07/09/key-trends-in-the-size-and-composition-of-otc-derivatives-markets-in-the-second-half-of-2025)

**Convergence tailwinds**
- [Davis Wright Tremaine — CFTC guidance on tokenized collateral + digital-asset pilot (Dec 2025)](https://www.dwt.com/blogs/financial-services-law-advisor/2025/12/cftc-tokenized-collateral-crypto-sprint)
- [Forbes — exchanges accept BUIDL as collateral](https://www.forbes.com/sites/digital-assets/2025/06/18/major-crypto-exchanges-to-accept-blackrocks-29-billion-tokenized-money-market-fund-as-collateral/) · [CoinDesk — BUIDL as Binance collateral](https://www.coindesk.com/business/2025/11/14/blackrock-s-usd2-5b-tokenized-fund-gets-listed-as-collateral-on-binance-expands-to-bnb-chain)
- [Eurex — DLT collateral-mobilization service go-live with HQLAx/Clearstream](https://www.hqla-x.com/post/eurex-clearing-dlt-enabled-collateral-mobilization-service) · [Euroclear — DLT for collateral mobility](https://www.euroclear.com/newsandinsights/en/Format/Whitepapers-Reports/dlt-to-enhance-collateral-mobility.html)

**Landscape**
- [Paradigm](https://paradigm.co/) · [DWF Labs — RFQ as crypto-OTC infrastructure](https://www.dwf-labs.com/research/rfq-in-otc-trading-the-infrastructure-layer-for-institutional-crypto) — ~$10B/mo, 700–1,000+ institutions, 20–30% of options flow
- [Yellow — Hyperliquid perp dominance](https://yellow.com/research/hyperliquid-perp-volume-dominance-how-2026) · [Motley Fool — Hyperliquid $1B revenue](https://www.fool.com/investing/2026/07/09/hyperliquid-has-now-generated-1-billion-in-revenue/) — ~70% of on-chain perps, $633B Q1 2026
- [Fortune — tokenized stocks: innovation or loophole](https://fortune.com/2025/07/14/tokenized-stocks-robinhood-openai-spacex-vlad-tenev/) — Robinhood SPCX/OpenAI tokens, OpenAI disavowal, ~$1B market +128% H2 2025

**Sui**
- [Sui — Mysticeti](https://www.sui.io/mysticeti) (~390 ms finality) · [Sui blog — DeepBook margin + suiUSDe](https://blog.sui.io/esui-dollar-suiusde-deepbook-margin/)
- [Sui at three: CME futures, staking ETFs, $2.6B DeFi TVL](https://www.mexc.com/news/1081102) · [DefiLlama — Sui TVL](https://defillama.com/chain/sui)
- [Sui Overflow 2026](https://overflow.sui.io/) — $500K+ prizes; financial-primitives + DeepBook tracks
