"use client";

import { useEffect, useState } from "react";
import { TxLink } from "./ExplorerLink";
import { useXHandles } from "@/lib/xHandles";

export interface Trade {
  signature: string;
  type: "buy" | "sell" | "rebalance";
  account: string;
  amount: number;
  tokenAmount: number;
  timestamp: number;
  /// Rebalance: USD moved (pairing/senior), for the tooltip. The table quotes ETH.
  skimmedUsd?: number;
  newLoopLev?: number;
  /// Rebalance sub-type: "protect" (deleverage), "relever" (re-lever), "release" (senior reallocation), or "paired" (first senior after graduation)
  rebalanceType?: "protect" | "relever" | "release" | "paired";
}

interface TradesTableProps {
  trades: Trade[];
  maxTrades?: number;
  creatorAddress?: string;
  userAddress?: string;
  onRefresh?: () => void;
  refreshing?: boolean;
  /// What the Amount column is denominated in. A coin's quote asset is WETH-shaped (18 decimals,
  /// labelled "ETH") or something like cbBTC (8 decimals, its own symbol) -- formatting an
  /// 8-decimal amount with 18-decimal habits printed 0.0000 for real trades.
  quoteSymbol?: string;
  quoteDecimals?: number;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50];
const DEFAULT_PAGE_SIZE = 10;
const MAX_TRADES_DEFAULT = 100;
const FILTER_KEY = "launchpad-frontend:trades-filter";

type FilterType = "all" | "creator" | "you" | "rebalance";

function loadFilter(): FilterType {
  if (typeof window === "undefined") return "all";
  try {
    const v = window.localStorage.getItem(FILTER_KEY);
    if (v === "all" || v === "creator" || v === "you" || v === "rebalance") return v;
  } catch {
    // private mode
  }
  return "all";
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatAmount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 })}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toLocaleString("en-US", { maximumFractionDigits: 2 })}k`;
  }
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatQuoteAmount(value: number, decimals: number): string {
  const places = Math.min(Math.max(decimals, 2), 8);
  return value.toLocaleString("en-US", { minimumFractionDigits: places <= 2 ? 2 : 4, maximumFractionDigits: places });
}

export default function TradesTable({
  trades,
  maxTrades = MAX_TRADES_DEFAULT,
  creatorAddress,
  userAddress,
  onRefresh,
  refreshing,
  quoteSymbol = "ETH",
  quoteDecimals = 18,
}: TradesTableProps) {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [page, setPage] = useState(0);
  const [accountFilter, setAccountFilter] = useState<FilterType>(loadFilter);
  const [showFilterDropdown, setShowFilterDropdown] = useState(false);
  const xHandles = useXHandles();

  useEffect(() => {
    try {
      window.localStorage.setItem(FILTER_KEY, accountFilter);
    } catch {
      // private mode
    }
  }, [accountFilter]);

  // Apply account filter
  const filteredTrades = trades.filter((t) => {
    if (accountFilter === "creator" && creatorAddress) {
      return t.account.toLowerCase() === creatorAddress.toLowerCase();
    }
    if (accountFilter === "you" && userAddress) {
      return t.account.toLowerCase() === userAddress.toLowerCase();
    }
    if (accountFilter === "rebalance") {
      return t.type === "rebalance";
    }
    return true;
  });

  // Only show last maxTrades
  const recentTrades = filteredTrades.slice(0, maxTrades);
  const totalPages = Math.ceil(recentTrades.length / pageSize);
  const paginatedTrades = recentTrades.slice(page * pageSize, (page + 1) * pageSize);

  const filterLabel = accountFilter === "all" ? "All trades" : accountFilter === "creator" ? "Creator" : accountFilter === "you" ? "You" : "Rebalances";

  return (
    <div>
      {/* Account Filter */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border">
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowFilterDropdown(!showFilterDropdown)}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium text-foreground hover:border-accent transition-colors"
          >
            {filterLabel}
            <svg className={`w-4 h-4 text-muted transition-transform ${showFilterDropdown ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {showFilterDropdown && (
            <div className="absolute top-full left-0 mt-1 w-40 rounded-lg border border-border bg-card shadow-lg z-10">
              {([
                { value: "all", label: "All trades" },
                { value: "creator", label: "Creator" },
                { value: "you", label: "You" },
                { value: "rebalance", label: "Rebalances" },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setAccountFilter(option.value);
                    setShowFilterDropdown(false);
                    setPage(0);
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-surface transition-colors ${
                    accountFilter === option.value ? "text-foreground" : "text-muted"
                  }`}
                >
                  {option.label}
                  {accountFilter === option.value && (
                    <svg className="w-4 h-4 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            title="Refresh trade history"
            className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm text-muted hover:text-foreground hover:border-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
          >
            <svg
              className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span className="text-xs font-medium">Refresh</span>
          </button>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted text-xs uppercase border-b border-border">
              <th className="text-left py-2 px-3 font-medium">#</th>
              <th className="text-left py-2 px-3 font-medium">Account</th>
              <th className="text-left py-2 px-3 font-medium">Type</th>
              <th className="text-right py-2 px-3 font-medium">Amount ({quoteSymbol})</th>
              <th className="text-right py-2 px-3 font-medium">Tokens</th>
              <th className="text-right py-2 px-3 font-medium">Time</th>
              <th className="text-right py-2 px-3 font-medium">Txn</th>
            </tr>
          </thead>
          <tbody>
            {paginatedTrades.map((t, i) => (
              <tr key={`${t.signature}-${t.rebalanceType ?? t.type}-${i}`} className="border-b border-border/50 hover:bg-card transition-colors">
                <td className="py-2.5 px-3 text-muted text-xs">
                  {page * pageSize + i + 1}
                </td>
                <td className="py-2.5 px-3 text-xs">
                  {t.type === "rebalance" ? (
                    <span className="font-mono text-accent">protocol</span>
                  ) : (() => {
                    const handle = xHandles.get(t.account.toLowerCase());
                    if (handle) {
                      return (
                        <a
                          href={`https://x.com/${handle}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={t.account}
                          className="font-medium text-foreground hover:text-accent transition-colors"
                        >
                          @{handle}
                        </a>
                      );
                    }
                    return (
                      <span className="font-mono text-secondary" title={t.account}>
                        {`${t.account.slice(0, 6)}...${t.account.slice(-4)}`}
                      </span>
                    );
                  })()}
                </td>
                <td className={`py-2.5 px-3 font-medium ${
                  t.type === "buy" ? "text-green" : t.type === "sell" ? "text-red" : t.rebalanceType === "relever" || t.rebalanceType === "paired" ? "text-green" : "text-red"
                }`}>
                  {t.type === "buy" ? "Buy" : t.type === "sell" ? "Sell" : t.rebalanceType === "protect" ? "Delever" : t.rebalanceType === "relever" ? "Relever" : t.rebalanceType === "release" ? "Peel" : t.rebalanceType === "paired" ? "Paired" : "Rebalance"}
                </td>
                <td className="text-right py-2.5 px-3 text-foreground font-mono">
                  {t.type === "rebalance" ? (
                    <span
                      className={t.rebalanceType === "relever" || t.rebalanceType === "paired" ? "text-green" : "text-red"}
                      title={
                        t.rebalanceType === "protect" ? `Vault ${quoteSymbol} sold for USDG — leverage down` :
                        t.rebalanceType === "relever" ? "Idle USDG bought vault collateral — leverage up" :
                        t.rebalanceType === "release" ? `Vault ${quoteSymbol} sold, senior moved to a louder coin` :
                        t.rebalanceType === "paired" ? `First senior paired after graduation — ${t.skimmedUsd ? `$${t.skimmedUsd.toFixed(2)}` : ""} attached at ${t.newLoopLev?.toFixed(2) ?? "2.00"}x (LYC → pool, traced via 0x81B4…)` :
                        "Protocol operation"
                      }
                    >
                      {`${t.rebalanceType === "relever" || t.rebalanceType === "paired" ? "+" : "−"}${formatQuoteAmount(t.amount, quoteDecimals)} ${quoteSymbol}`}
                    </span>
                  ) : (
                    formatQuoteAmount(t.amount, quoteDecimals)
                  )}
                </td>
                <td className={`text-right py-2.5 px-3 font-mono ${
                  t.type === "buy" ? "text-green" : t.type === "sell" ? "text-red" : "text-muted"
                }`}>
                  {t.type === "rebalance" ? (
                    <span className="text-xs" title="Loop leverage this rebalance targeted">
                      {t.newLoopLev ? `→ ${t.newLoopLev.toFixed(2)}x` : "—"}
                    </span>
                  ) : (
                    formatAmount(t.tokenAmount)
                  )}
                </td>
                <td className="text-right py-2.5 px-3 text-muted text-xs">
                  {timeAgo(t.timestamp)}
                </td>
                <td className="text-right py-2.5 px-3">
                  <TxLink hash={t.signature} />
                </td>
              </tr>
            ))}
            {recentTrades.length === 0 && (
              <tr>
                <td colSpan={7} className="py-8 text-center text-muted text-sm">
                  No trades yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: Pagination */}
      {recentTrades.length > 0 && (
        <div className="flex items-center justify-end px-3 py-2 border-t border-border">
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>Show</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setPage(0);
                }}
                className="rounded border border-border bg-surface px-2 py-1 text-foreground text-xs focus:outline-none focus:ring-1 focus:ring-accent"
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>{size}</option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1 text-xs">
              <button
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                ←
              </button>
              <span className="px-2 text-muted">
                {page + 1}/{totalPages}
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-2 py-1 rounded border border-border text-muted hover:text-foreground hover:bg-surface disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                →
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}