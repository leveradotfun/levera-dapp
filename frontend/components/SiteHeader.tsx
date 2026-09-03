"use client";

import Link from "next/link";
import { useAppState } from "@/lib/appState";
import TopBar from "@/components/TopBar";
import WalletMenu from "@/components/WalletMenu";

/// The top bar. Navigation moved to the left rail, so this holds only what is contextual to the
/// page you're on: back, search, create, and the wallet.
export default function SiteHeader() {
  const { setSearchQuery } = useAppState();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4">
        <div className="w-72">
          <TopBar onSearch={setSearchQuery} />
        </div>

        <div className="flex-1" />

        <Link
          href="/faucet"
          className="hidden shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-surface sm:flex"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M12 2.7s5.5 6.2 5.5 10.3a5.5 5.5 0 1 1-11 0C6.5 8.9 12 2.7 12 2.7Z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9.2 13.5a2.8 2.8 0 0 0 5.6 0" strokeLinecap="round" />
          </svg>
          Faucet
        </Link>

        <Link
          href="/create"
          className="hidden shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90 sm:flex"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.2}>
            <path strokeLinecap="round" d="M12 5v14M5 12h14" />
          </svg>
          Create
        </Link>

        <WalletMenu />
      </div>
    </header>
  );
}
