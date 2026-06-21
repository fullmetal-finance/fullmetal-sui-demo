export const runtime = "nodejs";
// cache the route's own response ~10min; both feeds update slowly, this is plenty
export const revalidate = 600;

/* Live USDC supply-side APRs for the three rehypothecation venues.
 *
 *  • Navi      — official no-auth API (genuinely live).
 *  • DeepBook  — computed live from the mainnet USDC MarginPool's own on-chain
 *                interest-rate model + utilisation, read over a public RPC (no
 *                API key, no SDK). This is DeepBook's real margin lending rate.
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

type NaviPool = {
  token?: { coinType?: string };
  supplyIncentiveApyInfo?: { vaultApr?: string };
};

/** Navi USDC base supply APR (percent), or null if the feed is unreachable. */
async function naviUsdcSupplyApr(): Promise<number | null> {
  try {
    const res = await fetchJson(NAVI_URL, undefined, { accept: "application/json" });
    const json = res as { data?: NaviPool[] } | NaviPool[];
    const pools = Array.isArray(json) ? json : (json.data ?? []);
    const usdc = pools.find((p) => p?.token?.coinType === NAVI_USDC);
    const v = parseFloat(usdc?.supplyIncentiveApyInfo?.vaultApr ?? "");
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** DeepBook USDC margin SUPPLY APR (percent), computed from the pool's on-chain
 *  interest-rate model + current utilisation. All model params are 1e9-scaled.
 *  borrow = util<=opt ? base + slope·(util/opt)
 *                     : base + slope + excess·((util-opt)/(1-opt))
 *  supply = borrow · util · (1 − protocolSpread)                              */
async function deepbookUsdcSupplyApr(): Promise<number | null> {
  try {
    const res = (await fetchJson(MAINNET_RPC, {
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getObject",
      params: [DEEPBOOK_USDC_POOL, { showContent: true }],
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
    return borrow * u * (1 - spread) * 100;
  } catch {
    return null;
  }
}

/** Suilend USDC SUPPLY APR (percent) from its mainnet reserve. The reserve
 *  carries a piecewise-linear borrow curve (interest_rate_utils% → aprs in bps);
 *  we interpolate at the live utilisation, then supply = borrow·util·(1−spread). */
async function suilendUsdcSupplyApr(): Promise<number | null> {
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
    // bps → fraction (÷10000), then supply = borrow·util·(1−spread), ×100 → percent
    return (bps / 10000) * u * (1 - spread) * 100;
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
    naviUsdcSupplyApr(),
    deepbookUsdcSupplyApr(),
    suilendUsdcSupplyApr(),
  ]);
  return Response.json({
    rates: {
      deepbook: deepbook ?? FALLBACK.deepbook,
      suilend: suilend ?? FALLBACK.suilend,
      navi: navi ?? FALLBACK.navi,
    },
    live: { deepbook: deepbook != null, suilend: suilend != null, navi: navi != null },
    fetchedAt: Date.now(),
  });
}
