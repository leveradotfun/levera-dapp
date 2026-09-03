"use client";

import { useAppState } from "@/lib/appState";
import { useHFycMetrics } from "@/lib/hfycMetrics";
import { TARGETING_TESTNET } from "@/lib/chains";

/// Lives in the root layout so NAV samples accumulate on every page, not only /earn.
export default function HFycMetricsRecorder() {
  const { addresses } = useAppState();
  // On testnet the repeated RPC calls (5+ per launch every 30s) are wasteful — skip entirely.
  useHFycMetrics(TARGETING_TESTNET ? null : addresses);
  return null;
}
