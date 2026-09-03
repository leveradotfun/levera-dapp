"use client";

import { useEffect, useRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider, useAccount, useSwitchChain } from "wagmi";
import { config } from "@/lib/wagmi";
import { isAppChain, ROBINHOOD_MAINNET_ID } from "@/lib/chains";

const queryClient = new QueryClient();

/// After a successful connect, ask the wallet to sit on Robinhood Chain so the first trade is
/// not a surprise switch (or worse, a tx on Ethereum). Rejection is left alone — the header
/// still shows "Switch to Robinhood Chain".
function WalletChainSync() {
  const { isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const attemptedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!isConnected) {
      attemptedFor.current = null;
      return;
    }
    if (chainId == null || isAppChain(chainId)) return;
    const key = `${chainId}`;
    if (attemptedFor.current === key) return;
    attemptedFor.current = key;
    switchChain({ chainId: ROBINHOOD_MAINNET_ID });
  }, [isConnected, chainId, switchChain]);

  return null;
}

export default function WalletProvider({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <WalletChainSync />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
