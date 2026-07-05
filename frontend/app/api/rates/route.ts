export const runtime = "nodejs";
// cache the route's own response ~10min; both feeds update slowly, this is plenty
export const revalidate = 600;

/* Live USDC supply-side APRs + venue risk metrics for the three rehypothecation
 * venues. The risk metrics are the per-venue adapter reads of
 * RISK-RESPONSIVE-REHYPOTHECATION.md §4:
 *   utilization  U_v  — borrowed / (borrowed + available)
 *   availableUsdc A_v — withdrawable liquidity NOW (max one-tx recall)
 *   kinkPct      U*_v — the rate model's kink; past it, exit liquidity is thinning
 *
 *  • Navi      — official no-auth API (genuinely live).
 *  • DeepBook  — computed live from the mainnet USDC MarginPool's own on-chain
 *                interest-rate model + utilisation, read over a public RPC.
 *  • Suilend   — computed live from its mainnet USDC reserve's piecewise-linear
 *                rate curve + utilisation, read over a public RPC. */

const NAVI_URL = "https://open-api.naviprotocol.io/api/navi/pools";
const NAVI_USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
// native-USDC TypeName prefix as it appears in on-chain coin_type names (no 0x)
const USDC_NAME_PREFIX = "dba34672";

const MAINNET_RPC = "https://fullnode.mainnet.sui.io:443";
// DeepBook mainnet USDC MarginPool (from the usdcMarginPoolCap.margin_pool_id)
const DEEPBOOK_USDC_POOL =
  "0xba473d9ae278f10af75c50a8fa341e9c6a1c087dc91a3f23e8048baf67d0754f";
// Suilend mainnet main-pool LendingMarket (USDC is one of its reserves)
const SUILEND_MARKET =
  "0x84030d26d85eaa7035084a057f2f11f701b7e2e4eda87551becbc7c97505ece1";

// indicative fallbacks (percent) — used only if a live read fails
const FALLBACK = { deepbook: 4.0, suilend: 5.1, navi: 5.4 } as const;

/** One venue's live read: supply APR + the §4 adapter risk metrics. */
type VenueRead = {
  apr: number; // supply APR, percent
  utilization: number | null; // U_v ∈ [0,1]
  availableUsdc: number | null; // A_v, whole USDC withdrawable now
  kinkPct: number | null; // U*_v, percent (rate model kink)
};

type NaviPool = {
  token?: { coinType?: string };
  supplyIncentiveApyInfo?: { vaultApr?: string };
  totalSupplyAmount?: string;
  borrowedAmount?: string;
  leftSupply?: string;
};

/** Navi USDC read: APR from their API, liquidity/utilisation from the same payload. */
async function naviUsdc(): Promise<VenueRead | null> {
  try {
    const res = await fetchJson(NAVI_URL, undefined, { accept: "application/json" });
    const json = res as { data?: NaviPool[] } | NaviPool[];
    const pools = Array.isArray(json) ? json : (json.data ?? []);
    const usdc = pools.find((p) => p?.token?.coinType === NAVI_USDC);
    const apr = parseFloat(usdc?.supplyIncentiveApyInfo?.vaultApr ?? "");
    if (!Number.isFinite(apr)) return null;
    // API amounts are 1e9-scaled (26552060021359955 ≈ 26.55M USDC — cross-checked
    // against the on-chain Pool<USDC>.balance)
    const supplied = Number(usdc?.totalSupplyAmount);
    const borrowed = Number(usdc?.borrowedAmount);
    const haveLiq = Number.isFinite(supplied) && Number.isFinite(borrowed) && supplied > 0;
    return {
      apr,
      utilization: haveLiq ? borrowed / supplied : null,
      availableUsdc: haveLiq ? Math.max(0, supplied - borrowed) / 1e9 : null,
      kinkPct: null, // Navi's kink lives in its rate-factor tables, not this API
    };
  } catch {
    return null;
  }
}

/** DeepBook USDC margin read, computed from the pool's on-chain interest-rate
 *  model + current utilisation. All model params are 1e9-scaled.
 *  borrow = util<=opt ? base + slope·(util/opt)
 *                     : base + slope + excess·((util-opt)/(1-opt))
 *  supply = borrow · util · (1 − protocolSpread)                              */
async function deepbookUsdc(): Promise<VenueRead | null> {
  try {
    const res = (await fetchJson(MAINNET_RPC, {
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getObject",
      params: [DEEPBOOK_USDC_POOL, { showContent: true }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as { result?: { data?: { content?: { fields?: Record<string, any> } } } };
    const f = res.result?.data?.content?.fields;
    if (!f) return null;
    const ic = f.config.fields.interest_config.fields;
    const mc = f.config.fields.margin_pool_config.fields;
    const st = f.state.fields;
    const S = 1e9;
    const base = Number(ic.base_rate) / S;
    const slope = Number(ic.base_slope) / S;
    const excess = Number(ic.excess_slope) / S;
    const opt = Number(ic.optimal_utilization) / S;
    const spread = Number(mc.protocol_spread) / S;
    const supplied = Number(st.total_supply);
    const borrowed = Number(st.total_borrow);
    if (!supplied) return null;
    const u = borrowed / supplied;
    const borrow =
      u <= opt
        ? base + (opt ? slope * (u / opt) : 0)
        : base + slope + excess * ((u - opt) / (1 - opt));
    return {
      apr: borrow * u * (1 - spread) * 100,
      utilization: u,
      availableUsdc: Math.max(0, supplied - borrowed) / 1e6,
      kinkPct: opt * 100,
    };
  } catch {
    return null;
  }
}

/** Suilend USDC read from its mainnet reserve. The reserve carries a piecewise-
 *  linear borrow curve (interest_rate_utils% → aprs in bps); we interpolate at
 *  live utilisation, then supply = borrow·util·(1−spread). The kink is the last
 *  curve breakpoint before 100% — beyond it the steep segment begins. */
async function suilendUsdc(): Promise<VenueRead | null> {
  try {
    const res = (await fetchJson(MAINNET_RPC, {
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getObject",
      params: [SUILEND_MARKET, { showContent: true }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as { result?: { data?: { content?: { fields?: any } } } };
    const reserves = res.result?.data?.content?.fields?.reserves;
    if (!Array.isArray(reserves)) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = reserves.find((x: any) => {
      const name: string = x?.fields?.coin_type?.fields?.name ?? "";
      return name.startsWith(USDC_NAME_PREFIX) && name.includes("usdc::USDC");
    });
    if (!r) return null;
    const cfg = r.fields.config.fields.element.fields;
    const utils: number[] = cfg.interest_rate_utils.map(Number);
    const aprs: number[] = cfg.interest_rate_aprs.map(Number); // bps
    const spread = Number(cfg.spread_fee_bps) / 10000;
    const avail = Number(r.fields.available_amount);
    const bv = r.fields.borrowed_amount?.fields?.value ?? r.fields.borrowed_amount;
    const borrowed = Number(bv) / 1e18; // Decimal → base units
    const denom = avail + borrowed;
    if (denom <= 0) return null;
    const u = borrowed / denom;
    const up = u * 100;
    let bps = aprs[aprs.length - 1];
    for (let i = 0; i < utils.length - 1; i++) {
      if (up <= utils[i + 1]) {
        const lo = utils[i];
        const hi = utils[i + 1];
        bps = aprs[i] + (aprs[i + 1] - aprs[i]) * (hi > lo ? (up - lo) / (hi - lo) : 0);
        break;
      }
    }
    // last breakpoint below 100% = where the steep segment starts
    const kinks = utils.filter((x) => x > 0 && x < 100);
    return {
      // bps → fraction (÷10000), then supply = borrow·util·(1−spread), ×100 → percent
      apr: (bps / 10000) * u * (1 - spread) * 100,
      utilization: u,
      availableUsdc: avail / 1e6,
      kinkPct: kinks.length ? kinks[kinks.length - 1] : null,
    };
  } catch {
    return null;
  }
}

/** POST a JSON-RPC body (or GET if body omitted); 4s timeout, 10min cache. */
async function fetchJson(
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      next: { revalidate: 600 },
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

export async function GET() {
  const [navi, deepbook, suilend] = await Promise.all([
    naviUsdc(),
    deepbookUsdc(),
    suilendUsdc(),
  ]);
  const risk = (v: VenueRead | null) =>
    v
      ? { utilization: v.utilization, availableUsdc: v.availableUsdc, kinkPct: v.kinkPct }
      : { utilization: null, availableUsdc: null, kinkPct: null };
  return Response.json({
    rates: {
      deepbook: deepbook?.apr ?? FALLBACK.deepbook,
      suilend: suilend?.apr ?? FALLBACK.suilend,
      navi: navi?.apr ?? FALLBACK.navi,
    },
    live: { deepbook: deepbook != null, suilend: suilend != null, navi: navi != null },
    // per-venue adapter reads (RISK-RESPONSIVE-REHYPOTHECATION.md §4)
    risk: { deepbook: risk(deepbook), suilend: risk(suilend), navi: risk(navi) },
    fetchedAt: Date.now(),
  });
}
