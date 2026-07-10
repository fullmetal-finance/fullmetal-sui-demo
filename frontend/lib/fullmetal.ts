/* ------------------------------------------------------------------ */
/*  Fullmetal on-chain config — deployed testnet package + singletons.  */
/*  Every screen imports addresses + Move-call targets from here so the */
/*  demo has ONE source of truth. Keep in sync with ARCHITECTURE.md §13. */
/* ------------------------------------------------------------------ */

/** Current deployed package (upgrade w/ EWMA vol oracle, rehypo router,
 *  settle_on_breach crank, two-way RFQ; demo cure window 90s). */
export const PACKAGE =
  "0xf8b57f09dfe5e59fcc176110c8f15cf96b27f6f23be8a4db959529d896635a4a";

/** Original package id — stable across upgrades; witness type-names key on it. */
export const ORIGINAL_PACKAGE =
  "0x3dfbfa5254f00a0b501ebfdf449f044340e09f0629b37dfa7d834130157dfddf";

/** Protocol-global shared singletons (created at first publish). */
export const SHARED = {
  otcAllowlist:
    "0x6adb6cb2a30e37a9255138a56981516f1267d2284fc06f28917034ad7413e68a",
  handleRegistry:
    "0x1b18463c8e784b709f326787520e313f62eb75485ac2163673720d77eefddcc8",
  riskOracle:
    "0xac39229ae9e9547582aa607c1bc084b42fd722aa5e74595af16875efcffb4cdd",
} as const;

/** DeepBook margin pool the institution rehypothecates into (real testnet). */
export const DEEPBOOK = {
  dbusdcMarginPool:
    "0xf08568da93834e1ee04f09902ac7b1e78d3fdf113ab4d2106c7265e95318b14d",
  marginRegistry:
    "0x48d7640dfae2c6e9ceeada197a7a1643984b5a24c55a0c6c023dac77e0339f75",
} as const;

/** Settlement collateral. DBUSDC is 6-decimal; prices/quantities are 1e6-scaled. */
export const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

export const CLOCK = "0x6";

export const DECIMALS = 6;
export const UNIT = 1_000_000; // 1e6

/** Protocol collateral floor (demo). IM (each side) must be ≥ max(this, IM% × notional). */
export const PROTOCOL_MIN_IM = 1; // USD (demo floor; on-chain only requires im > 0)
export const MIN_IM_PCT = 0.05; // ≥5% of notional ⇒ up to 20× leverage
export const MAINTENANCE_PCT = 0.7; // MM = 70% of IM (MAINTENANCE_BPS = 7000 on-chain)

export const INTERVAL_MS = { hourly: 3_600_000, daily: 86_400_000 } as const;

/** Demo underlying — SPCX (SpaceX), freshly public + volatile. Marks in USD. */
export const SPCX = {
  symbol: "SPCX",
  label: "SpaceX",
  initialMark: 185,
  spikeMark: 240, // +29% > 15% trigger threshold → latches the oracle
  // on-chain feed `jump_threshold_bps` (1500) — a push whose |Δ|/prev exceeds
  // this latches the trigger and the permissionless recall fires. (With the
  // EWMA layer armed, a z > 4σ move latches even earlier — see SPCX_VOL.)
  triggerPct: 15,
} as const;

/** EWMA vol calibration armed on the SPCX feed (oracle::enable_vol). Demo
 *  cadence: λ is tuned so the whole latch→release arc fits a ~14-tick,
 *  ~1.2s/print scenario (production would run λ≈0.94 on real print cadence).
 *  Must match scripts/post-upgrade-setup.ts; retunable live via retune_vol. */
export const SPCX_VOL = {
  seedSigmaBps: 150, // 1.5%/print warm start
  lambdaBps: 6_000, // λ = 0.60
  zLatchX100: 400, // 4.0σ shock latch
  sigmaCeilBps: 800, // 8%/print regime latch
  thetaRelBps: 7_000, // release band: σ < 0.7·ceil = 560 bps
  releaseNeeded: 3, // consecutive in-band prints to unlatch
} as const;

/** Fully-qualified Move-call targets, grouped by module. */
export const TARGET = {
  institution: {
    create: `${PACKAGE}::institution::create_institution`,
    deposit: `${PACKAGE}::institution::deposit_treasury`,
    withdraw: `${PACKAGE}::institution::withdraw_treasury`,
    grantTrader: `${PACKAGE}::institution::grant_trader`,
    setBookSize: `${PACKAGE}::institution::set_book_size`,
    reservedOf: `${PACKAGE}::institution::reserved_of`,
    rehypothecatedOf: `${PACKAGE}::institution::rehypothecated_of`,
    contractView: `${PACKAGE}::institution::contract_view`,
    equity: `${PACKAGE}::institution::equity`,
    available: `${PACKAGE}::institution::available`,
  },
  direct: {
    propose: `${PACKAGE}::direct::propose_direct`,
    accept: `${PACKAGE}::direct::accept_direct`,
    withdraw: `${PACKAGE}::direct::withdraw_direct`,
    reclaim: `${PACKAGE}::direct::reclaim_expired_direct`,
  },
  rfq: {
    open: `${PACKAGE}::rfq::open_rfq`,
    submitQuote: `${PACKAGE}::rfq::submit_quote`,
    acceptQuote: `${PACKAGE}::rfq::accept_quote`,
    withdrawQuote: `${PACKAGE}::rfq::withdraw_quote`,
  },
  otc: {
    settle: `${PACKAGE}::otc_forward::settle`,
    close: `${PACKAGE}::otc_forward::close`,
    pnlAt: `${PACKAGE}::otc_forward::pnl_at`,
    settleOnBreach: `${PACKAGE}::otc_forward::settle_on_breach`,
    mmBreached: `${PACKAGE}::otc_forward::mm_breached`,
    marginCallDeadline: `${PACKAGE}::otc_forward::margin_call_deadline`,
  },
  rehypo: {
    rehypothecate: `${PACKAGE}::rehypo::rehypothecate`,
    recall: `${PACKAGE}::rehypo::recall`,
    recallOnTrigger: `${PACKAGE}::rehypo::recall_on_trigger`,
    suppliedValue: `${PACKAGE}::rehypo::supplied_value`,
  },
  router: {
    setCollateralParams: `${PACKAGE}::rehypo_router::set_collateral_params`,
    setVenueConfig: `${PACKAGE}::rehypo_router::set_venue_config`,
    setLiquidityFloor: `${PACKAGE}::rehypo_router::set_liquidity_floor`,
    collateralParams: `${PACKAGE}::rehypo_router::collateral_params`,
    requiredFloor: `${PACKAGE}::rehypo_router::required_floor`,
    deployable: `${PACKAGE}::rehypo_router::deployable`,
    principalOf: `${PACKAGE}::rehypo_router::principal_of`,
  },
  oracle: {
    pushPrice: `${PACKAGE}::oracle::push_price`,
    pushPriceV2: `${PACKAGE}::oracle::push_price_v2`,
    clearTrigger: `${PACKAGE}::oracle::clear_trigger`,
    registerFeed: `${PACKAGE}::oracle::register_feed`,
    mintKeeperCap: `${PACKAGE}::oracle::mint_keeper_cap`,
    enableVol: `${PACKAGE}::oracle::enable_vol`,
    disableVol: `${PACKAGE}::oracle::disable_vol`,
    retuneVol: `${PACKAGE}::oracle::retune_vol`,
    price: `${PACKAGE}::oracle::price`,
    isTriggered: `${PACKAGE}::oracle::is_triggered`,
    hasFeed: `${PACKAGE}::oracle::has_feed`,
    hasVol: `${PACKAGE}::oracle::has_vol`,
    volBps: `${PACKAGE}::oracle::vol_bps`,
    releaseProgress: `${PACKAGE}::oracle::release_progress`,
  },
  registry: {
    resolve: `${PACKAGE}::registry::resolve`,
  },
} as const;

/** Every move-call target the app sponsors — passed to Enoki's `sender`-branch
 *  `allowedMoveCallTargets` so the gas pool only covers Fullmetal calls. */
export const ALL_MOVE_TARGETS: string[] = Object.values(TARGET).flatMap((m) =>
  Object.values(m),
);

/** Object-type strings for filtering `objectChanges` after a tx. On-chain
 *  object types key on the ORIGINAL package id, stable across upgrades. */
export const TYPE = {
  institution: `${ORIGINAL_PACKAGE}::institution::Institution<${DBUSDC_TYPE}>`,
  adminCap: `${ORIGINAL_PACKAGE}::institution::AdminCap`,
  traderCap: `${ORIGINAL_PACKAGE}::institution::TraderCap`,
  directOffer: `${ORIGINAL_PACKAGE}::direct::DirectOffer<${DBUSDC_TYPE}>`,
  rfq: `${ORIGINAL_PACKAGE}::rfq::Rfq<${DBUSDC_TYPE}>`,
  otcForward: `${ORIGINAL_PACKAGE}::otc_forward::OtcForward<${DBUSDC_TYPE}>`,
} as const;

// ---- display helpers (6dp collateral / 1e6 prices) ----

/** 6dp on-chain integer (string|number|bigint) → human number. */
export function fromUnits(v: string | number | bigint): number {
  return Number(BigInt(v)) / UNIT;
}

/** Human number → 6dp on-chain bigint. */
export function toUnits(v: number): bigint {
  return BigInt(Math.round(v * UNIT));
}

/** USD formatting for DBUSDC amounts. */
export function usd(v: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
    ...opts,
  }).format(v);
}

export const explorer = {
  object: (id: string) => `https://suiscan.xyz/testnet/object/${id}`,
  tx: (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`,
};
