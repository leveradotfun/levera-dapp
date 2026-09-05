"use client";

import Link from "next/link";
import { useAppState } from "@/lib/appState";
import { TARGETING_TESTNET } from "@/lib/chains";
import TopBar from "@/components/TopBar";
import WalletMenu from "@/components/WalletMenu";

/// The top bar. Navigation moved to the left rail, so this holds only what is contextual to the
/// page you're on: back, search, create, and the wallet.
export default function SiteHeader() {
  const { setSearchQuery } = useAppState();

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/80 backdrop-blur-md">
      <div className="flex h-14 items-center gap-3 px-4">
        {/* The rail is hidden on phones, so the logo mark lives here instead. */}
        <Link href="/" className="shrink-0 md:hidden" aria-label="levera">
          <img src="/logo.svg" alt="" className="h-6 w-6 rounded-md" />
        </Link>

        {/* Network indicator: every deployment of this app is a testnet prototype, and people
            should never have to check the RPC to know it. Rendered only when the app actually
            targets testnet, so a future mainnet build goes dark automatically. */}
        {TARGETING_TESTNET ? (
          <span
            className="hidden shrink-0 rounded-md bg-accent px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-accent-ink sm:inline-block"
            title="All assets here are testnet mocks. Nothing on this site has real value."
          >
            Testnet
          </span>
        ) : null}

        <div className="min-w-0 flex-1 md:w-72 md:flex-none">
          <TopBar onSearch={setSearchQuery} />
        </div>

        <div className="hidden flex-1 md:block" />

        <Link
          href="/faucet"
          className="flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-surface sm:px-3"
          aria-label="Faucet"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-4 w-4">
            <path d="M12 2.7s5.5 6.2 5.5 10.3a5.5 5.5 0 1 1-11 0C6.5 8.9 12 2.7 12 2.7Z" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9.2 13.5a2.8 2.8 0 0 0 5.6 0" strokeLinecap="round" />
          </svg>
          <span className="hidden sm:inline">Faucet</span>
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
