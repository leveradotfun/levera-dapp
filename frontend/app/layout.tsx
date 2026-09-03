import type { Metadata } from "next";
import "./globals.css";
import WalletProvider from "@/components/WalletProvider";
import { AppStateProvider } from "@/lib/appState";
import SiteHeader from "@/components/SiteHeader";
import SideRail from "@/components/SideRail";
import GlobalModals from "@/components/GlobalModals";
import ToastHost from "@/components/ToastHost";
import ProtocolKeeper from "@/components/ProtocolKeeper";
import HFycMetricsRecorder from "@/components/HFycMetricsRecorder";

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
                  whole page and pushing the rail off-screen. */}
              <div className="flex min-w-0 flex-1 flex-col">
                <SiteHeader />
                <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-4">{children}</main>
              </div>
            </div>
            <GlobalModals />
            <ToastHost />
            <ProtocolKeeper />
            <HFycMetricsRecorder />
          </AppStateProvider>
        </WalletProvider>
      </body>
    </html>
  );
}
