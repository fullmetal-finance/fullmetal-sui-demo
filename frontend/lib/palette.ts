/* Chart & graphic colors. Categorical palette validated (dataviz six checks:
   lightness band, chroma floor, CVD adjacency, surface contrast) against the
   app's light surface; identity is never color-alone (labels/swatches always
   present). Status red/green are reserved for state, never for series. */

/** Fixed-order categorical hues (contracts, series) — assign by index, never cycle. */
export const CATEGORICAL = ["#2456c4", "#b45309", "#7a5cd6", "#0d9488"] as const;

export const CHART = {
  price: "#2456c4", // price line (blue)
  sigma: "#7a5cd6", // EWMA σ line + wash (violet)
} as const;

/** Status colors (state, not identity) — match the app's existing usage. */
export const STATUS = {
  red: "#b4341f",
  green: "#1f6f4d",
} as const;

/** Collateral-MOVEMENT colors — deliberately vivid/saturated so the back-and-
 *  forth (deploy out to earn / recall home on risk) reads across a demo room. */
export const FLOW = {
  deploy: "#16a34a", // collateral going OUT to venues (vivid green)
  recall: "#e11d2e", // collateral pulled HOME on risk (vivid red)
} as const;

/** Per-venue accent hues for the collateral manager cards — brightened for
 *  demo legibility (the allocation strip's segments move as collateral flows). */
export const VENUE_ACCENT: Record<"deepbook" | "suilend" | "navi", string> = {
  deepbook: "#2563eb",
  suilend: "#0ea5a0",
  navi: "#ea580c",
};
