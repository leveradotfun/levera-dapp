"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { useAccount, useBalance, useDisconnect, useSwitchChain } from "wagmi";
import { ROBINHOOD_MAINNET_ID } from "@/lib/chains";

interface WalletDropdownProps {
  onConnectClick: () => void;
}

export default function WalletDropdown({ onConnectClick }: WalletDropdownProps) {
  const { address, isConnected, chain } = useAccount();
  const { data: balanceData } = useBalance({ address });
  const { disconnect } = useDisconnect();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) {
      setOpen(false);
      setShowAddress(false);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [handleClickOutside]);

  if (!mounted) {
    return (
      <button
        onClick={onConnectClick}
        className="bg-accent text-accent-ink font-semibold px-4 py-2 rounded-lg text-sm hover:brightness-110 transition-all cursor-pointer"
      >
        Connect Wallet
      </button>
    );
  }

  if (!isConnected || !address) {
    return (
      <button
        onClick={onConnectClick}
        className="bg-accent text-accent-ink font-semibold px-4 py-2 rounded-lg text-sm hover:brightness-110 transition-all cursor-pointer"
      >
        Connect Wallet
      </button>
    );
  }

  const balance = balanceData ? parseFloat(balanceData.formatted).toFixed(4) : "0.0000";
  const symbol = balanceData?.symbol ?? "ETH";
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  const isCorrectChain = chain?.id === ROBINHOOD_MAINNET_ID;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 bg-card border border-border rounded-full pl-1.5 pr-3 py-1.5 text-sm hover:border-muted transition-colors cursor-pointer"
      >
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-accent/30 to-accent/10 flex items-center justify-center text-[10px] font-bold text-accent border border-accent/20">
          {address.slice(2, 4).toUpperCase()}
        </div>
        <span className="text-secondary font-medium hidden sm:block">{short}</span>
        <svg className={`w-3.5 h-3.5 text-muted transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-72 bg-card border border-border rounded-2xl shadow-2xl z-50 overflow-hidden">
          <div className="p-3 border-b border-border">
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted">Connected</span>
              {!isCorrectChain && (
                <button
                  onClick={() => switchChain({ chainId: ROBINHOOD_MAINNET_ID })}
                  className="text-xs text-yellow hover:text-yellow/80 transition-colors"
                >
                  Switch to RH Chain
                </button>
              )}
            </div>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-accent/30 to-accent/10 flex items-center justify-center text-xs font-bold text-accent border border-accent/20">
                {address.slice(2, 4).toUpperCase()}
              </div>
              <div>
                <button
                  onClick={() => setShowAddress(!showAddress)}
                  className="text-sm font-semibold text-foreground hover:text-accent transition-colors cursor-pointer"
                >
                  {showAddress ? address : short}
                </button>
                <div className="text-xs text-muted">
                  {balance} {symbol}
                </div>
              </div>
            </div>
          </div>

          <div className="p-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(address);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-foreground hover:bg-surface transition-colors"
            >
              <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
              Copy address
            </button>

            <a
              href={chain?.blockExplorers?.default?.url ? `${chain.blockExplorers.default.url}/address/${address}` : "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-foreground hover:bg-surface transition-colors"
            >
              <svg className="w-4 h-4 text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              View on explorer
            </a>

            <button
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm text-red hover:bg-red/10 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
