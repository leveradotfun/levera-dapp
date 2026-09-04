import type { Metadata } from "next";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";
import { AppStateProvider } from "@/lib/appState";
import SiteHeader from "@/components/SiteHeader";
import SideRail from "@/components/SideRail";
import MobileNav from "@/components/MobileNav";
import GlobalModals from "@/components/GlobalModals";
import ToastHost from "@/components/ToastHost";
import ProtocolKeeper from "@/components/ProtocolKeeper";
import LycMetricsRecorder from "@/components/LycMetricsRecorder";

export const metadata: Metadata = {
  title: "Robinhood Launchpad",
  description: "Leveraged memecoin launchpad",
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
                  whole page and pushing the rail off-screen. Bottom padding clears the phone-only
                  MobileNav bar. */}
              <div className="flex min-w-0 flex-1 flex-col">
                <SiteHeader />
                <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4 pb-28 md:pb-4">{children}</main>
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
