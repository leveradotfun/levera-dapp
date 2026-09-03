"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { resetProvider } from "./signers";
import {
  DeployedAddresses,
  loadDeployedAddresses,
  normalizeDeployedAddresses,
  saveDeployedAddresses,
  wipeFrontendDeploymentState,
} from "@/lib/chain";
import { LaunchSummary, fetchAllLaunches, resetLaunchCaches } from "@/lib/launchpad";
import { setScanStartBlock } from "@/lib/launchStats";
import { TARGETING_TESTNET } from "@/lib/chains";

/// App-wide state that used to live in a single page component's useState calls before real
/// routes existed. Lifted into a context + provider (mounted once in app/layout.tsx) so every
/// route -- home, a coin's detail page, a demo token's detail page -- shares the same deployment,
/// launch list, and header/modal state instead of each page re-deriving or losing it on navigate.
type View = "table" | "grid";

interface AppState {
  addresses: DeployedAddresses | null;
  launches: LaunchSummary[];
  /// False until the first launch fetch has completed (successfully or not). Without this an empty
  /// `launches` is ambiguous, and the grid resolved that ambiguity the wrong way -- rendering "No
  /// coins launched yet" while the very first read was still in flight.
  launchesLoaded: boolean;
  refreshLaunches: () => Promise<void>;
  view: View;
  setView: (v: View) => void;
  // Matches whatever TopBar's own hardcoded filter list emits -- kept as a plain string rather
  // than a duplicated union so the two never drift out of sync.
  filter: string;
  setFilter: (f: string) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  walletModalOpen: boolean;
  setWalletModalOpen: (v: boolean) => void;
  handleConnectClick: () => void;
}

const VIEW_KEY = "launchpad-frontend:explore-view";
const FILTER_KEY = "launchpad-frontend:explore-filter";

const AppStateContext = createContext<AppState | null>(null);

export function AppStateProvider({ children }: { children: React.ReactNode }) {
  const [addresses, setAddresses] = useState<DeployedAddresses | null>(null);
  const [launches, setLaunches] = useState<LaunchSummary[]>([]);
  const [launchesLoaded, setLaunchesLoaded] = useState(false);
  const [view, setView] = useState<View>("grid");
  const [filter, setFilter] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(VIEW_KEY);
      if (v === "table" || v === "grid") setView(v);
      const f = window.localStorage.getItem(FILTER_KEY);
      if (f) setFilter(f);
    } catch {
      // private mode
    }
  }, []);

  const persistView = useCallback((v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_KEY, v);
    } catch {
      // private mode
    }
  }, []);

  const persistFilter = useCallback((f: string) => {
    setFilter(f);
    try {
      window.localStorage.setItem(FILTER_KEY, f);
    } catch {
      // private mode
    }
  }, []);

  useEffect(() => {
    // Paint whatever this origin already has, then keep polling the shared file. The console
    // lives on another port so it cannot clear our localStorage; a wipe there deletes the file
    // and writes a new one, and this loop is how we notice.
    const local = loadDeployedAddresses();
    if (local) {
      setScanStartBlock(local.deployBlock);
      setAddresses(local);
    }

    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      try {
        // ?chain=testnet follows the same NEXT_PUBLIC_RPC_URL switch the provider and the wallet
        // transport use, so a testnet-targeted app never adopts the fork's addresses.
        const r = await fetch(TARGETING_TESTNET ? "/api/deployment?chain=testnet" : "/api/deployment");
        if (stopped) return;
        if (r.status === 404) {
          const current = loadDeployedAddresses();
          if (current) {
            wipeFrontendDeploymentState(current.factory);
            resetProvider();
            resetLaunchCaches();
            setAddresses(null);
            setLaunches([]);
            setLaunchesLoaded(true);
          }
        } else if (r.ok) {
          const d = normalizeDeployedAddresses(await r.json());
          if (d?.factory) {
            const current = loadDeployedAddresses();
            const different = !current || current.factory.toLowerCase() !== d.factory.toLowerCase();
            const newer = !current || (d.updatedAt ?? 0) > (current.updatedAt ?? 0);
            if (different || newer) {
              // Same CREATE address after anvil_reset is still a new chain: old ledgers
              // and price history belong to coins that no longer exist.
              wipeFrontendDeploymentState(current?.factory);
              saveDeployedAddresses(d);
              resetProvider();
              // In-memory per-address caches (quote asset, symbol, trade history) are keyed by
              // address, and addresses repeat across deployments -- so they have to go with the
              // provider, not outlive it.
              resetLaunchCaches();
              setScanStartBlock(d.deployBlock);
              setAddresses(d);
            }
          }
        }
      } catch {
        // network hiccup -- retry
      }
      if (!stopped) timer = setTimeout(attempt, 3000);
    };
    attempt();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const refreshLaunches = useCallback(async () => {
    if (!addresses) return;
    try {
      const all = await fetchAllLaunches(addresses);
      setLaunches(all);
    } catch (e) {
      // Anvil down or a stale deployment is an expected, self-correcting state and the empty list
      // covers it -- but swallowing this silently also hid a real "the whole coin list is empty for
      // a reason that isn't obvious" bug, so it goes to the console rather than nowhere.
      console.error("failed to refresh launches", e);
    } finally {
      // Marked loaded even on failure: a failed read is still "we tried", and leaving it false
      // forever would pin the UI in a skeleton state with no way out.
      setLaunchesLoaded(true);
    }
  }, [addresses]);

  // 2s, not the 400ms this was: each refresh reads every launch's on-chain state AND scans its
  // trade events, so at 400ms the refreshes overlapped each other and buried the node in requests
  // faster than they could complete. The event scan is incremental now (see lib/launchStats.ts),
  // but a poll interval still has to leave room for the round trip it starts.
  //
  // A remote target needs far more room: one refresh is ~100 RPC calls, and the shared testnet
  // RPC rate-limits hard at that rate -- every over-limit read fails, coins blink out of the
  // list, and the dev overlay fills with unhandled "Failed to fetch". 15s keeps the page live
  // without tripping the limit.
  useEffect(() => {
    if (!addresses) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    // Self-scheduling rather than setInterval: the next refresh is queued only once the previous
    // one has finished, so a slow round trip delays the next poll instead of stacking up behind it.
    const loop = async () => {
      await refreshLaunches();
      if (!stopped) timer = setTimeout(loop, TARGETING_TESTNET ? 60_000 : 2_000);
    };
    loop();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [addresses, refreshLaunches]);

  const handleConnectClick = useCallback(() => {
    setWalletModalOpen(true);
  }, []);

  return (
    <AppStateContext.Provider
      value={{
        addresses,
        launches,
        launchesLoaded,
        refreshLaunches,
        view,
        setView: persistView,
        filter,
        setFilter: persistFilter,
        searchQuery,
        setSearchQuery,
        walletModalOpen,
        setWalletModalOpen,
        handleConnectClick,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within AppStateProvider");
  return ctx;
}
