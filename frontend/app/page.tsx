"use client";

import { useRouter } from "next/navigation";
import { useAppState } from "@/lib/appState";
import LiveLaunchGrid from "@/components/LiveLaunchGrid";
import LiveLaunchTable from "@/components/LiveLaunchTable";
import ExploreStats from "@/components/ExploreStats";
import { SkeletonCoinCard } from "@/components/Skeleton";

type FilterType = "All" | "New" | "Leveraged" | "Graduated";

export default function Home() {
  const router = useRouter();
  const { addresses, launches, launchesLoaded, view, setView, searchQuery, filter, setFilter } = useAppState();

  const filters: FilterType[] = ["All", "New", "Leveraged", "Graduated"];
  const activeFilter = (filters as string[]).includes(filter) ? (filter as FilterType) : "All";

  const filteredLaunches = launches.filter((l) => {
    if (activeFilter === "New" && (l.stats.createdAt === null || Date.now() - l.stats.createdAt > 3600000)) return false;
    if (activeFilter === "Leveraged" && !l.leverageEnabled) return false;
    if (activeFilter === "Graduated" && !l.graduated) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      l.name.toLowerCase().includes(q) ||
      l.symbol.toLowerCase().includes(q) ||
      l.address.toLowerCase().includes(q)
    );
  });

  if (!addresses) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="text-center">
          <div className="text-lg text-muted mb-2">Connecting to network...</div>
          <div className="text-sm text-muted">Waiting for contract addresses</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Explore</h1>
        <p className="mt-0.5 text-sm text-muted">
          {launchesLoaded
            ? `${launches.length.toLocaleString("en-US")} coin${launches.length === 1 ? "" : "s"} live · one curve, every coin priced by its own liquidity`
            : "Loading…"}
        </p>
      </div>

      <ExploreStats launches={launches} addresses={addresses} />

      {/* Filter Tabs */}
      <div className="mb-6 flex flex-wrap items-center gap-2 gap-y-2">
        {filters.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              activeFilter === f
                ? "bg-accent text-accent-ink"
                : "bg-card border border-border text-muted hover:text-foreground"
            }`}
          >
            {f}
          </button>
        ))}

        <div className="flex-1" />

        {/* View Toggle */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setView("grid")}
            className={`p-2 rounded-lg transition-colors ${view === "grid" ? "bg-surface text-foreground" : "text-muted hover:text-foreground"}`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
            </svg>
          </button>
          <button
            onClick={() => setView("table")}
            className={`p-2 rounded-lg transition-colors ${view === "table" ? "bg-surface text-foreground" : "text-muted hover:text-foreground"}`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 5.25h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5m-16.5 4.5h16.5" />
            </svg>
          </button>
        </div>
      </div>

      {/* Skeletons only while the FIRST read is outstanding. Later refreshes keep the current
          coins on screen rather than flashing placeholders every two seconds. */}
      {!launchesLoaded ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }, (_, i) => (
            <SkeletonCoinCard key={i} />
          ))}
        </div>
      ) : view === "grid" ? (
        <LiveLaunchGrid
          launches={filteredLaunches}
          onSelect={(l) => router.push(`/coin/${l.address}`)}
        />
      ) : (
        <LiveLaunchTable
          launches={filteredLaunches}
          onSelect={(l) => router.push(`/coin/${l.address}`)}
        />
      )}
    </div>
  );
}