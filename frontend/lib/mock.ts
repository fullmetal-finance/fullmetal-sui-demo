/* Demo seed data — clearly-mock desk roster, open positions, and competing RFQ
   quotes so the dashboard reads like a live institutional desk. Real session
   rows (the user's own on-chain contracts/quotes) are merged in alongside these
   and are the only ones with Suiscan links. */

export type MockTrader = {
  name: string;
  address: string;
  book: number; // book-size limit (USD)
  used: number; // deployed
  role: string;
};

export const MOCK_TRADERS: MockTrader[] = [
  { name: "A. Whitfield", address: "0x9c4a…71e2", book: 500_000, used: 312_500, role: "Head of desk" },
  { name: "M. Okonkwo", address: "0x3f81…a0d4", book: 250_000, used: 143_000, role: "Senior trader" },
  { name: "S. Rinaldi", address: "0x77b2…5c19", book: 150_000, used: 55_500, role: "Trader" },
];

export type MockPosition = {
  asset: string;
  side: "long" | "short";
  trader: string;
  cpty: string;
  notional: number; // USD
  entry: number;
  mark: number;
  im: number;
  maturity: string;
  venue: string; // rehypothecation venue
  otcId?: string; // real (on-chain) rows carry the OtcForward id
  cptyId?: string; // real rows: the counterparty institution id (full)
  status?: number; // real rows: 0 active · 1 settled · 2 liquidated
  expiryMs?: number; // real rows: contract expiry (0 = perpetual)
};

export const MOCK_POSITIONS: MockPosition[] = [
  { asset: "AAPL", side: "long", trader: "A. Whitfield", cpty: "Cumberland", notional: 925_000, entry: 232.5, mark: 241.8, im: 92_500, maturity: "30d", venue: "DeepBook" },
  { asset: "JPY", side: "short", trader: "M. Okonkwo", cpty: "Galaxy", notional: 555_000, entry: 157.9, mark: 156.4, im: 55_500, maturity: "Perp", venue: "Suilend" },
  { asset: "BTC", side: "long", trader: "A. Whitfield", cpty: "Wintermute", notional: 1_200_000, entry: 64_200, mark: 66_800, im: 120_000, maturity: "7d", venue: "Navi" },
];

/** RFQs broadcast to this desk by OTHER institutions — the maker side of the
 *  book. Quoting on them is mocked for the demo. */
export type IncomingRfq = {
  id: string;
  from: string; // requesting institution
  asset: string;
  side: "buy" | "sell" | "two-way";
  notional: number; // USD
  tenor: string;
  ageMins: number;
  refPrice: number; // last mark, prefilled into the quote form
};

export const MOCK_INCOMING_RFQS: IncomingRfq[] = [
  { id: "rfq-aurora", from: "Aurora Capital", asset: "SPCX", side: "buy", notional: 740_000, tenor: "30d", ageMins: 3, refPrice: 148 },
  { id: "rfq-meridian", from: "Meridian Markets", asset: "BTC", side: "two-way", notional: 1_500_000, tenor: "Perp", ageMins: 11, refPrice: 66_800 },
  { id: "rfq-tessera", from: "Tessera Trading", asset: "SPCX", side: "sell", notional: 410_000, tenor: "14d", ageMins: 26, refPrice: 148 },
];

export type MockCounterparty = { name: string; status: "approved" };
export const MOCK_COUNTERPARTIES: MockCounterparty[] = [
  { name: "Cumberland", status: "approved" },
  { name: "Galaxy Digital", status: "approved" },
  { name: "Wintermute", status: "approved" },
  { name: "B2C2", status: "approved" },
];

/** Forward long PnL in USD given a USD notional. */
export function positionPnl(p: { entry: number; mark: number; notional: number; side: "long" | "short" }): number {
  const dir = p.side === "long" ? 1 : -1;
  return ((p.mark - p.entry) / p.entry) * p.notional * dir;
}
