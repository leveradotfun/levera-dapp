"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useAppState } from "@/lib/appState";
import { LaunchSummary, fetchLaunchSummary } from "@/lib/launchpad";
import LaunchDetail from "@/components/LaunchDetail";

/// A real, shareable, deep-linkable URL per coin -- fetched directly by address rather than only
/// looked up in the polled `launches` list, so hitting /coin/0x... straight from a link (or a
/// reload) works even before the home page's own poll has populated that list.
export default function CoinPage() {
  const router = useRouter();
  const params = useParams<{ address: string }>();
  const address = params.address;
  const { addresses, launches, refreshLaunches } = useAppState();

  const [launch, setLaunch] = useState<LaunchSummary | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    // If the polled list already has it, use that immediately -- avoids a flash of "loading" on
    // ordinary in-app navigation from the grid.
    const cached = launches.find((l) => l.address.toLowerCase() === address.toLowerCase());
    if (cached) {
      setLaunch(cached);
      return;
    }
    if (!addresses) return;
    let stopped = false;
    // Per-launch price resolution: the summary reads the coin's own oracle, so a cbBTC-quoted
    // coin is priced off the cbBTC feed rather than the global ETH one.
    fetchLaunchSummary(address)
      .then((s) => {
        if (!stopped) setLaunch(s);
      })
      .catch(() => {
        if (!stopped) setNotFound(true);
      });
    return () => {
      stopped = true;
    };
  }, [address, addresses, launches]);

  if (notFound) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <p className="text-sm text-secondary">No coin found at that address.</p>
        <button onClick={() => router.push("/")} className="mt-2 text-sm text-accent hover:underline">
          Back to all coins
        </button>
      </div>
    );
  }

  if (!launch) {
    return <div className="p-10 text-center text-sm text-muted">Loading coin...</div>;
  }

  return (
    <LaunchDetail
      launch={launch}
      addresses={addresses}
      onBack={() => router.push("/")}
      onRefresh={refreshLaunches}
    />
  );
}
