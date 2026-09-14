import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import "./globals.css";
import { organisationJsonLd, siteUrl } from "@/lib/seo";

/**
 * One typeface for the whole shop.
 *
 * It used to be two — a serif for headings and a grotesk for everything else.
 * The owner asked for the modern rounded catalogue voice instead, and a serif
 * display face is the one thing that brief rules out, so both roles are now
 * played by weights of a single geometric sans with softened terminals.
 * Loading one variable family also takes a font file off the critical path of
 * a first screen that is now dominated by a photograph.
 */
const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
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

/*
 * `cover` lets the page run under an iPhone's rounded corners and home
 * indicator, which is what makes `env(safe-area-inset-*)` report real values.
 * Without it every `env()` in the stylesheet reads zero, and the sticky buy
 * bar sat on top of the home indicator.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${figtree.variable} h-full antialiased`}
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
