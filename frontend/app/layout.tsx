import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SITE } from "@/lib/site";
import Providers from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE.url),
  title: {
    default: `${SITE.shortName} Demo — Smart collateral on Sui`,
    template: `%s — ${SITE.shortName} Demo`,
  },
  description: SITE.description,
  applicationName: `${SITE.shortName} Demo`,
  openGraph: {
    type: "website",
    url: SITE.url,
    siteName: `${SITE.shortName} Demo`,
    title: `${SITE.shortName} Demo — Smart collateral on Sui`,
    description: SITE.description,
    images: [{ url: SITE.ogImage, width: SITE.ogImageWidth, height: SITE.ogImageHeight }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
