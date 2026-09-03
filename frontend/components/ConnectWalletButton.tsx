"use client";

import { useAppState } from "@/lib/appState";

export default function ConnectWalletButton({
  label = "Connect Wallet",
  className,
}: {
  label?: string;
  className?: string;
}) {
  const { handleConnectClick } = useAppState();
  return (
    <button
      type="button"
      onClick={handleConnectClick}
      className={
        className ??
        "w-full rounded-lg bg-accent py-3 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90"
      }
    >
      {label}
    </button>
  );
}
