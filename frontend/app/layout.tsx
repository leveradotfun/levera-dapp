import type { Metadata } from "next";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";
import { AppStateProvider } from "@/lib/appState";
import SiteHeader from "@/components/SiteHeader";
import SideRail from "@/components/SideRail";
import MobileNav from "@/components/MobileNav";
import TrendingMarquee from "@/components/TrendingMarquee";
import GlobalModals from "@/components/GlobalModals";
import ToastHost from "@/components/ToastHost";
import ProtocolKeeper from "@/components/ProtocolKeeper";
import LycMetricsRecorder from "@/components/LycMetricsRecorder";

export const metadata: Metadata = {
  // Absolute base for social/OG URLs -- relative image paths can't be read by crawlers without
  // it. Set NEXT_PUBLIC_SITE_URL in production (e.g. the Vercel domain); localhost is just the
  // dev fallback.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002"),
  title: "Levera - First leveraged memecoin launchpad",
  description: "Leveraged memecoin launchpad",
  openGraph: {
    type: "website",
    siteName: "Levera",
    title: "Levera - First leveraged memecoin launchpad",
    description: "Leveraged memecoin launchpad",
    url: "/",
    images: [{ url: "/open-graph-image.png", width: 800, height: 400, alt: "Levera" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Levera - First leveraged memecoin launchpad",
    description: "Leveraged memecoin launchpad",
    images: ["open-graph-image.png"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProvider>
          <AppStateProvider>
            <div className="flex min-h-screen bg-bg">
              <SideRail />
              {/* min-w-0 so a wide table scrolls inside this column instead of stretching the
                  whole page and pushing the rail off-screen. Bottom padding clears the MobileNav
                  bar (below md) and the swap card's fixed trade bar (below lg). */}
              <div className="flex min-w-0 flex-1 flex-col">
                <SiteHeader />
                <TrendingMarquee />
                <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 pb-28 lg:pb-4">{children}</main>
              </div>
            </div>
            <MobileNav />
            <GlobalModals />
            <ToastHost />
            <ProtocolKeeper />
            <LycMetricsRecorder />
          </AppStateProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
