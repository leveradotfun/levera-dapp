"use client";

import { useAppState } from "@/lib/appState";
import { useProtocolKeeper } from "@/lib/keeper";

/// Runs the permissionless upkeep this app can do on a visitor's behalf. It deliberately does NOT
/// write book snapshots: the console sweeps every registered pool on one clock, and a second
/// sampler on a different clock would interleave two views of the same book into one series.
export default function ProtocolKeeper() {
  const { addresses } = useAppState();
  useProtocolKeeper(addresses);
  return null;
}
