"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAppState } from "@/lib/appState";
import { useWallet } from "@/lib/wallet";
import ConnectWalletButton from "@/components/ConnectWalletButton";

export default function ProfilePage() {
  const router = useRouter();
  const { addresses } = useAppState();
  const wallet = useWallet(addresses);

  useEffect(() => {
    if (wallet.address) {
      router.replace(`/profile/${wallet.address}`);
    }
  }, [wallet.address, router]);

  if (!wallet.isConnected) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <h1 className="text-2xl font-bold text-foreground">Connect a wallet</h1>
        <p className="max-w-md text-sm text-muted">Your profile lives at <span className="font-mono text-foreground">/profile/0x…</span> — connect to view yours.</p>
        <ConnectWalletButton className="rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink" />
        <p className="text-xs text-muted">Example: <a href="/profile/0x667eb85F074446353FE49F75517808dA549e785e" className="text-accent hover:underline font-mono">/profile/0x667eb85F074446353FE49F75517808dA549e785e</a></p>
      </div>
    );
  }

  return <div className="p-10 text-center text-sm text-muted">Redirecting to {wallet.address ? `${wallet.address.slice(0, 6)}…` : "your profile"}…</div>;
}
