/* Local persistence for the off-chain institution profile (the SaaS/KYB layer).
   On-chain we store only the handle, treasury, and caps; the email / phone /
   address / logo are off-chain. For the demo this lives in localStorage keyed by
   the signed-in zkLogin address — zero backend. In production this is a database
   (Postgres/KV) keyed by institution id. */

export type InstitutionProfile = {
  legalName: string;
  email: string;
  phone: string;
  address: string;
  jurisdiction: string;
};

export type InstitutionRecord = {
  handle: string;
  institutionId: string;
  adminCapId: string;
  traderCapId?: string;
  profile: InstitutionProfile;
  logo?: string | null;
  txDigest: string;
  createdAt: number;
  rfqIds?: string[]; // open RFQs this desk has broadcast
  otcIds?: string[]; // opened OtcForward contracts
};

const key = (addr: string) => `fullmetal:institution:${addr.toLowerCase()}`;

export function saveInstitution(addr: string, rec: InstitutionRecord): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(key(addr), JSON.stringify(rec));
}

export function loadInstitution(addr: string): InstitutionRecord | null {
  if (typeof window === "undefined") return null;
  const v = localStorage.getItem(key(addr));
  return v ? (JSON.parse(v) as InstitutionRecord) : null;
}

export function clearInstitution(addr: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(key(addr));
}

export type StoredQuote = { org: string; quoteId: string; price: number; im: number; ttl: string };

export function saveQuotes(rfqId: string, quotes: StoredQuote[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(`fullmetal:quotes:${rfqId}`, JSON.stringify(quotes));
}

export function loadQuotes(rfqId: string): StoredQuote[] {
  if (typeof window === "undefined") return [];
  const v = localStorage.getItem(`fullmetal:quotes:${rfqId}`);
  return v ? (JSON.parse(v) as StoredQuote[]) : [];
}
