import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";
import "./globals.css";
import { organisationJsonLd, siteUrl } from "@/lib/seo";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  // Relative canonicals and Open Graph URLs resolve against this.
  metadataBase: new URL(siteUrl()),
  title: {
    default: "Preorder American goods, delivered in Bangladesh",
    template: "%s · Manifest",
  },
  description:
    "Preorder niche American products, sourced and shipped to your door in Bangladesh with a fixed price and a stated arrival window.",
  openGraph: {
    type: "website",
    siteName: "Manifest",
    locale: "en_GB",
  },
  // No Twitter card image yet; declaring one without the asset is worse than
  // letting the platform fall back to the page description.
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${fraunces.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(organisationJsonLd()),
          }}
        />
        {children}
      </body>
    </html>
  );
}
