/* ------------------------------------------------------------------ */
/*  Central site configuration for the demo app.                       */
/*  Mirrors fullmetal-web's lib/site.ts so styling/components port     */
/*  cleanly. Copy/flow is placeholder until the product pages land.    */
/* ------------------------------------------------------------------ */

export const SITE = {
  name: "Fullmetal.Finance",
  shortName: "Fullmetal",
  domain: "demo.fullmetal.finance",
  url: "https://demo.fullmetal.finance",
  description:
    "Institutional OTC derivatives with risk-responsive collateral rehypothecation, on Sui.",
  tagline: "The missing collateral efficiency layer for institutional finance.",
  ogImage: "/logo.png",
  ogImageWidth: 1920,
  ogImageHeight: 1080,
} as const;

export const CONTACT = {
  email: "adrija@fullmetal.finance",
  telegramHandle: "t.me/buildwithadrija",
  telegramUrl: "https://t.me/buildwithadrija",
} as const;

// Top navigation — placeholder until the app pages exist.
export const NAV_LINKS: { label: string; href: string; external?: boolean }[] = [
  { label: "Fullmetal.Finance", href: "https://fullmetal.finance", external: true },
];
