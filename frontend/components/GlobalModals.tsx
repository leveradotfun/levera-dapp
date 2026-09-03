"use client";

import { useAppState } from "@/lib/appState";
import WalletModal from "@/components/WalletModal";

/// Overlays that need to be reachable from any route. Mounted once in app/layout.tsx, outside
/// <main>, so navigating between routes never unmounts them mid-flow. "Launch a coin" used to live
/// here as a modal; it's now the full-page route at app/create.
export default function GlobalModals() {
  const { walletModalOpen, setWalletModalOpen } = useAppState();

  return (
    <>
      <WalletModal open={walletModalOpen} onClose={() => setWalletModalOpen(false)} />
    </>
  );
}
