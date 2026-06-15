# fullmetal-sui-demo
 Time to build the product and architecture for fullmetal (Institutional OTC derivatives with cross-margined risk-responsive collateral rehypothecation) for the sui overflow hackathon mvp. The goal of the product is to serve large institutions participating in bilateral derivative trades and use the blockchain to create a capital efficient collateral management which rehypothecates collateral to interest avenues (deepbook margin pool for this demo) and dynamically withdraws collateral rehypothecated when certain volatility or market triggers are activated. Traditionally large sums of collateral remain idle and there are many intermediaries managing the collateral, taking more fees for themselves and huge administrative complexity while instution posting the collateral earns no interest on it. 
 
 Use the Sui MCP to find sui related info.
 First iteration will be focusing on the risk responsive collateral rehypothecation to deepbook's margin pool. We settle in usdc for the otc derivatives. 
 
 What we want to do is discuss the object types, general code structure etc for this basic flow. 

 We are building a mono repo.

 We will need -
 1. An instutional wallet - which im guessing should be a smart contract multisig or something on those lines with admins and trader permissions. Please check this esepcially for "access" library. 
 https://mystenlabs.notion.site/OpenZeppelin-s-audited-Move-Libraries-and-Tools-36d6d9dcb4e980539272ded72c2856f6
 
 2. Then the otc contract itself - the choice can be between perpetuals, forward (time commitment lock in between two parties), or hybrid (commitment lock in and into flexible perpetual), the funding rate for perps and hybrid will probably require some special math/formula for bilateral party calculation so as of the first iteration we just keep it a fixed number. The instution chooses underlying asset, notional size, entry, collateral asset (usdc for now). Counterparty can either be known or RFQ can be used.

 Each instution will have its "margin account". Note that FULL margin is dynamically rehypothecated and tracked not partial so make sure you look into how accounting must be done in sui across the derivative margin requirement that is changing and also the margin amount in deepbook margin pool.   
 
 I want you to note that i want a cross margin design to be possible although but first build aim right now is to get the rehypothecation pieces connected end to end. 
 
 Initial margin is sent by the instutions when the contract is opened. 
 Variation margin is sent by losing institution to winning instution everyday based mark to market. It will get stored in the margin account (and rehypothecated. note rehypothecation interest is for the winning instution always) but the excess variation margin can be withdrawn any time.
 Maintence margin is a protocol number below initial margin where we liquidate and close position (70 percent of initial margin). 
 
3. risk-responsive rehypothecation contracts - we can have one trigger to test. 
Please check if it is possible with using deepbook sandbox
https://github.com/MystenLabs/deepbook-sandbox

Openzeppelin move libraries will probably be needed for the math
 https://mystenlabs.notion.site/OpenZeppelin-s-audited-Move-Libraries-and-Tools-36d6d9dcb4e980539272ded72c2856f6


4. nextjs frontend 
this should be a very simple demo . You can refer to fullmetal-web in the same directory as fullmetal-sui-demo for the styling

I plan to host on vercel at demo.fullmetal.finance

What i need to build is an RFQ system to get quotes from other instutions 

and please take a look at this typescript
https://sdk.mystenlabs.com/sui


Five decisions the research settles
1. Build on testnet, not the sandbox. The deepbook-sandbox is a localnet-only Docker stack (Sui localnet + DeepBook + margin pools + a local USDC + Pyth updater). It can't back a hosted demo at demo.fullmetal.finance. But testnet has live margin pools today (margin package, registry, and pools all verified on-chain). Keep the sandbox as two things: a local integration-test environment, and a code reference — its sandbox/scripts/utils/pool.ts contains the exact working PTB sequence for mint_supplier_cap → supply → withdraw.

2. "USDC" on testnet means DBUSDC. Testnet has no native-USDC margin pool. The stablecoin pool is DBUSDC (DeepBook's 6-decimal test USDC). Code against a generic Asset type parameter, point it at DBUSDC on testnet, and label it "USDC" in the UI — the same code targets the real USDC pool on mainnet (which exists, 2M supply cap). Day-1 task: verify how to acquire DBUSDC (check for a public mint; fallback is swapping faucet SUI on the testnet SUI/DBUSDC DeepBook pool).

3. Institutional wallet: on-chain role objects, not native multisig. Sui native multisig is authentication-layer only (max 10 keys, invisible to Move code), and browser wallets have no real multisig signing flow — Mysten built a whole separate platform (Sagat) just to coordinate signatures. For a hackathon demo where each role is a browser wallet, the right design is an on-chain Institution shared object with role permissions. The OpenZeppelin openzeppelin_access::access_control library (v1.2.0, audited June 2026, published on testnet) is excellent but has a constraint: one registry per module, created with a one-time witness at publish. So use it for protocol-level roles (RiskKeeper, ProtocolAdmin) where one registry is exactly right, and use Sui-idiomatic capability objects + allowlists for per-institution admin/trader tiers (admins grant/revoke trader caps). Mention in your pitch that the root admin address can be a native multisig — OZ even provides new_with_admin for that.

4. Derivative for v1: a cash-settled forward with a fixed funding field. Of your three candidates (perp / forward / hybrid), the forward is the simplest contract that still produces everything the demo needs — daily mark-to-market, variation margin flows, and liquidation. Add a fixed_funding_rate_bps field and an optional expiry_ms to the struct now: with expiry = None and funding switched on it is your perp, and the hybrid becomes a v2 parameter change, not a redesign.

5. Oracle for v1: your own keeper-pushed price object. Pyth works on Sui testnet but is pull-based (Hermes service + update transactions through Wormhole) — real integration overhead with no demo payoff. A PriceOracle shared object that a keeper role pushes prices into is less code and a better demo: a "simulate −15% crash" button in your risk console makes the trigger fire live on stage. Pyth is the stretch goal (the margin package itself already depends on Pyth, so the dependency is in your tree anyway).

Move architecture
One package, fullmetal, eight modules:


contracts/sources/
├── roles.move            # OZ access_control registry: ProtocolAdminRole, KeeperRole (OTW init)
├── institution.move      # Institution shared object: name, admin allowlist, trader allowlist,
│                         #   AdminCap / TraderCap issuance + revocation
├── margin_account.move   # ONE per institution (cross-margin ready) — the heart
├── rehypo.move           # deploy/recall between account and DeepBook margin pool
├── oracle.move           # PriceOracle shared object, keeper-pushed, stores prev price + timestamp
├── otc.move              # OTCContract: open (two-step deposit), mark_to_market, settle, liquidate
├── rfq.move              # RFQ shared object: post request → collect quotes → accept opens contract
└── events.move           # all events (frontend reads these for the activity feed)
The MarginAccount answers your README question about accounting across a changing margin requirement plus a deepbook pool position:


public struct MarginAccount has key {
    id: UID,
    institution: ID,
    idle: Balance<USDC>,              // collateral held locally, not deployed
    supplier_cap: SupplierCap,        // THE rehypothecation handle (one per account)
    principal_deployed: u64,          // book value pushed into the pool
    requirements: Table<ID, Req>,     // per-contract margin requirements ← cross-margin ready
    total_required: u64,              // cached sum across contracts
}
The accounting identity that makes everything work:

equity = idle + margin_pool::user_supply_amount(pool, cap_id, clock) — exact at execution time because the pool view is public Move, so no stale snapshots
interest earned = pool value − principal_deployed (computed, realized on withdrawal — and since variation margin lands in the winner's account and gets redeployed under the winner's cap, "interest always belongs to the winner" falls out of per-account accounting for free)
health = equity / total_required; the requirements table means adding a second contract later just adds a row — that's your cross-margin path without building it now
DeepBook's pool uses appreciating shares (no rebasing), with a kinked utilization-based rate; supplier APR = borrow rate × utilization × (1 − 20% protocol spread). One real constraint to design around: withdrawals can be partially blocked by pool utilization and a token-bucket rate limiter, so rehypo::recall must tolerate getting less than requested (recall what's available, emit a shortfall event, retry). At demo scale on testnet you control utilization, so it won't bite, but judges who know lending pools will ask.

Math: use openzeppelin_fp_math — SD29x9 gives you signed PnL (Move has no signed ints) and UD30x9 9-decimal prices; openzeppelin_math::u64::mul_div handles the 6-decimal USDC ↔ 9-decimal price conversions safely.

The end-to-end lifecycle (this is also your demo script)
Onboard — two institutions ("Alice Capital", "Bob Securities"); each admin grants a trader cap. Each gets a MarginAccount.
RFQ — Alice's trader posts an RFQ (SUI/USD forward, 10k notional); Bob quotes a price; Alice accepts. Acceptance escrows Alice's initial margin in a proposal; Bob's deposit activates the OTCContract.
Auto-rehypothecation — on activation, both accounts' full margin is supplied to the DeepBook USDC margin pool under each account's SupplierCap. Dashboard shows collateral earning live, utilization-driven APR instead of sitting idle — your headline moment.
Daily MTM crank — keeper pushes a new price and calls mark_to_market: loser's variation margin is recalled from their pool position, credited to the winner's account, and immediately redeployed under the winner's cap. Winner can withdraw excess VM (anything above required margin) at any time.
Risk trigger — keeper pushes a crash price; the volatility trigger (|Δprice| > threshold bps since last mark) fires and recalls collateral from the pool to idle for affected accounts — the "risk-responsive" moment, visible in the event feed.
Liquidation — MTM finds the loser's equity below maintenance (70% of IM): position closes, final PnL pays the winner from the loser's collateral, remainder returned, accrued interest displayed.
Monorepo layout

fullmetal-sui-demo/
├── contracts/                 # Sui Move package (Move.toml + sources/ + tests/)
├── packages/sdk/              # TS: tx builders for your package, object parsers, network constants
├── packages/scripts/          # deploy, seed demo institutions, keeper crank (price push + MTM)
├── apps/web/                  # Next.js 16 / React 19 / Tailwind v4
└── pnpm-workspace.yaml
Key Move.toml dependencies:


deepbook_margin    = { git = "https://github.com/MystenLabs/deepbookv3.git", subdir = "packages/deepbook_margin", rev = "..." }
openzeppelin_access  = { r.mvr = "@openzeppelin-move/access" }
openzeppelin_math    = { r.mvr = "@openzeppelin-move/integer-math" }
openzeppelin_fp_math = { r.mvr = "@openzeppelin-move/fixed-point-math" }
(Pin the deepbook rev to what's actually deployed on testnet — resolve current package IDs from @mysten/deepbook-v3's utils/constants.ts, since the docs page lags the on-chain registry, which version-gates old packages.)

Frontend
Stack: match fullmetal-web — Next 16, React 19, Tailwind v4. Port globals.css design tokens (warm-paper --bg, ink palette, mono .eyebrow labels, Geist fonts) plus the Nav/Footer/Logo components for brand continuity.
Sui integration: use dApp Kit 2.0 (@mysten/dapp-kit-react + @mysten/sui 2.x with SuiGrpcClient) — the old @mysten/dapp-kit hooks you'll see in most tutorials are now deprecated/JSON-RPC-only, so don't mix the two stacks. One Next.js gotcha: wallet detection is browser-only, so all dApp Kit components live behind a 'use client' wrapper dynamically imported with ssr: false.
Four screens: Dashboard (equity split idle vs. deployed, live pool APR, interest accrued, health gauge), Trade/RFQ, Position detail (MTM history, VM ledger), and a Risk console (price chart, push-price/crash button, trigger + liquidation event feed). Poll shared-object state with react-query refetchInterval and read your Move events for the feed.
Funding the demo: SUI from faucet.sui.io; DBUSDC per the day-1 verification above.
Build order
M0 — Prove the linchpin (day 1). Scaffold repo, Sui CLI ≥ 1.72, Move.toml compiles with both dependencies. Write a throwaway TS script: mint SupplierCap, supply 1 DBUSDC to the testnet pool, read user_supply_amount, withdraw. Do this before any product code — it de-risks the entire hackathon.
M1 — Custody + rehypothecation (days 2–3). roles, institution, margin_account, rehypo: deposit → auto-deploy → recall, end to end against the real testnet pool. Unit-test the pure math; integration-test pool interaction via scripts.
M2 — Derivative lifecycle (days 4–6). oracle, otc: two-step open, MTM/VM crank, the volatility trigger, liquidation at 70% IM. Milestone: full lifecycle runs from a CLI script on testnet.
M3 — RFQ (day 7). Request → quote → accept wiring into the same open path.
M4 — Frontend (days 8–11). Port styling, build the four screens, keeper buttons in the risk console.
M5 — Ship (days 12+). Vercel deploy + demo.fullmetal.finance DNS, seed script for the two demo institutions, rehearse the six-step demo, write the README/pitch.
Gotchas to keep on a sticky note
supply() returns your cumulative shares after the op, not the delta.
Recalls can be partial (utilization + rate limiter) — handle shortfalls gracefully.
DBUSDC is 6 decimals, your fixed-point prices are 9 — every conversion goes through mul_div.
OZ access-control registries are one-per-module (OTW) — that's why institution roles are caps, not OZ roles.
The testnet margin package may lack newer views like true_interest_rate — compute supplier APR client-side as interest_rate × utilization × (1 − spread).
Don't gate MTM on a literal 24h on testnet — make the interval a parameter so the demo can crank freely.
Everything above is sourced from: OpenZeppelin contracts-sui (the Notion page is JS-rendered and unfetchable, but it points there; v1.2.0 audited, published on testnet), deepbookv3 margin sources + DeepBook Margin docs, deepbook-sandbox, and the Mysten SDK docs — with the testnet object IDs verified on-chain during research and saved to memory for our next session.

Natural next step when you're ready: I can scaffold the monorepo and write the M0 proof script so you can validate the supply/withdraw loop on testnet today.

