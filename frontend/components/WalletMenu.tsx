"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { useRouter } from "next/navigation";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { walletSeesContracts } from "@/lib/activeSigner";
import { useAppState } from "@/lib/appState";
import { useWallet, shortAddress } from "@/lib/wallet";
import { formatWad } from "@/lib/launchpad";
import { toastSuccess, toastError } from "@/lib/toast";
import {
  isAppChain,
  ROBINHOOD_MAINNET_ID,
  ROBINHOOD_TESTNET_ID,
  TARGETING_TESTNET,
  RPC_URL,
  robinhood,
  robinhoodTestnet,
} from "@/lib/chains";
import { getWalletClient } from "wagmi/actions";
import { config } from "@/lib/wagmi";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import { useXAuth } from "@/lib/useXAuth";

/// Deterministic avatar colours from the address, so the same wallet always looks the same without
/// storing anything.
///
/// Shifts here MUST be unsigned (>>>). `>>` converts to a signed int32 first, so any hash above
/// 2^31 -- roughly half of them -- comes out negative, and `%` keeps the sign in JavaScript. In an
/// hsl() that yields a negative hue; where the same pattern indexed an array it returned undefined
/// and crashed outright.
function gradientFor(address: string): string {
  let h = 0;
  for (let i = 2; i < address.length; i++) h = (h * 31 + address.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 60 + ((h >>> 8) % 120)) % 360;
  return `linear-gradient(135deg, hsl(${a} 70% 55%), hsl(${b} 70% 45%))`;
}

/// Connected-wallet chip: balance, avatar, and a menu. When nobody is connected this is the
/// Connect Wallet button that opens terms + the wallet picker.
export default function WalletMenu() {
  const router = useRouter();
  const { addresses } = useAppState();
  const wallet = useWallet(addresses);
  const xAuth = useXAuth(wallet.address);
  const { address, isConnected, chain } = useAccount();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [walletBlind, setWalletBlind] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const onDocClick = useCallback((e: MouseEvent) => {
    if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
  }, []);

  useEffect(() => {
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onDocClick]);

  // Same chain id, different node: see walletSeesContracts(). Must run on every render —
  // the connect-button return below used to sit above this and trip the rules of hooks
  // the moment a wallet actually connected.
  useEffect(() => {
    let cancelled = false;
    if (!addresses?.factory || !isConnected) {
      setWalletBlind(false);
      return;
    }
    walletSeesContracts(addresses.factory).then((sees) => {
      if (!cancelled) setWalletBlind(sees === false);
    });
    return () => {
      cancelled = true;
    };
  }, [addresses?.factory, isConnected, chain?.id]);

  const onAppChain = isAppChain(chain?.id);
  const targetChain = TARGETING_TESTNET ? robinhoodTestnet : robinhood;
  const targetChainId = targetChain.id;
  const targetRpc = RPC_URL;
  const isCorrectChain = chain?.id === targetChainId;

  const handleFixNetwork = useCallback(async () => {
    try {
      await switchChain({ chainId: targetChainId as 4663 | 46630 | 31337 });
      toastSuccess(`Switched to ${targetChain.name}`);
    } catch {
      // Chain not in wallet — try to add it
      try {
        const walletClient = await getWalletClient(config);
        const request = (walletClient as unknown as { request?: (a: { method: string; params: unknown[] }) => Promise<unknown> })?.request;
        if (!request) throw new Error("No wallet request");
        await request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: `0x${targetChainId.toString(16)}`,
              chainName: targetChain.name,
              nativeCurrency: targetChain.nativeCurrency,
              rpcUrls: [targetRpc],
              blockExplorerUrls: [targetChain.blockExplorers.default.url],
            },
          ],
        });
        await switchChain({ chainId: targetChainId as 4663 | 46630 | 31337 });
        toastSuccess(`${targetChain.name} added — switched`);
      } catch (addErr) {
        toastError(addErr, `Failed to add ${targetChain.name} — add it manually with RPC ${targetRpc}`);
      }
    }
  }, [switchChain, targetChain, targetChainId, targetRpc]);

  if (!mounted || !isConnected || !address) {
    return (
      <ConnectWalletButton className="shrink-0 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink transition-opacity hover:opacity-90" />
    );
  }

  const short = shortAddress(address);
  // Each token in its own decimals: ETH/WETH/USDG are 18, cbBTC is 8 — formatWad assumes 18 and
  // would render a 0.5 cbBTC balance as 5e-9.
  const eth = wallet.balances ? formatWad(wallet.balances.eth, 3) : "—";
  const weth = wallet.balances ? formatWad(wallet.balances.weth, 3) : "—";
  const cbbtc = wallet.balances ? ethers.formatUnits(wallet.balances.cbbtc, 8) : "—";
  const usdg = wallet.balances ? formatWad(wallet.balances.usdg, 2) : "—";

  function go(href: string) {
    setOpen(false);
    router.push(href);
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-3 pr-1 text-sm transition-colors hover:border-muted"
      >
        {!isCorrectChain ? (
          <span className="h-1.5 w-1.5 rounded-full bg-yellow" title="Wrong network" />
        ) : null}
        <span className="font-mono text-xs text-foreground">{eth} ETH</span>
        {xAuth.profile ? (
          <img
            src={xAuth.profile.profileImageUrl}
            alt={xAuth.profile.username}
            className="h-7 w-7 rounded-full object-cover"
          />
        ) : (
          <span
            className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold text-white/90"
            style={{ background: gradientFor(address) }}
          >
            {address.slice(2, 4).toUpperCase()}
          </span>
        )}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <div className="flex items-center gap-3 border-b border-border p-3">
            {xAuth.profile ? (
              <img
                src={xAuth.profile.profileImageUrl}
                alt={xAuth.profile.username}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <span
                className="flex h-10 w-10 items-center justify-center rounded-full text-xs font-bold text-white/90"
                style={{ background: gradientFor(address) }}
              >
                {address.slice(2, 4).toUpperCase()}
              </span>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                {xAuth.profile ? (
                  <span className="text-sm font-semibold text-foreground">@{xAuth.profile.username}</span>
                ) : (
                  <span className="font-mono text-sm text-foreground">{short}</span>
                )}
                <span
                  className={`h-1.5 w-1.5 rounded-full ${isCorrectChain ? "bg-green" : "bg-yellow"}`}
                  title={isCorrectChain ? "Connected" : "Wrong network"}
                />
              </div>
              <div className="text-[11px] text-muted">
                {xAuth.profile ? short : wallet.connectorName ?? "Connected"}
                {!isCorrectChain ? " · wrong network" : ""}
              </div>
            </div>
          </div>

          {isCorrectChain && walletBlind ? (
            <div className="border-b border-border bg-yellow/10 px-3 py-2.5 text-[11px] leading-relaxed text-yellow">
              <div>
                Your wallet is on chain {targetChainId}, but its RPC can&apos;t see this deployment — it&apos;s
                pointed at a different node than the app. MetaMask keeps one entry per chain id, so
                switching won&apos;t replace it.
              </div>
              <button
                onClick={handleFixNetwork}
                disabled={switching}
                className="mt-2 w-full rounded-lg bg-yellow px-3 py-1.5 text-xs font-semibold text-black hover:bg-yellow/90 disabled:opacity-50"
              >
                {switching ? "Fixing…" : `Fix RPC → ${targetRpc}`}
              </button>
              <div className="mt-1 opacity-80">
                Or manually edit the network&apos;s RPC to <code className="font-mono">{targetRpc}</code>
              </div>
            </div>
          ) : null}

          {!isCorrectChain ? (
            <button
              onClick={handleFixNetwork}
              disabled={switching}
              className="w-full border-b border-border bg-yellow/10 px-3 py-2.5 text-left text-sm font-medium text-yellow hover:bg-yellow/15 disabled:opacity-50"
            >
              {switching ? "Switching…" : `Add & switch to ${targetChain.name} (${targetChainId})`}
            </button>
          ) : null}

          <div className="grid grid-cols-2 gap-px bg-border">
            <div className="bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted">ETH</div>
              <div className="font-mono text-sm text-foreground">{eth}</div>
            </div>
            <div className="bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted">WETH</div>
              <div className="font-mono text-sm text-foreground">{weth}</div>
            </div>
            <div className="bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted">cbBTC</div>
              <div className="font-mono text-sm text-foreground">{cbbtc}</div>
            </div>
            <div className="bg-card p-3">
              <div className="text-[10px] uppercase tracking-wide text-muted">USDG</div>
              <div className="font-mono text-sm text-foreground">{usdg}</div>
            </div>
          </div>

          <div className="p-2">
            {/* X connect/disconnect lives on the profile page; the faucet page replaced the test
                top-up, and the explorer link is one click deeper in Profile & holdings. */}
            <MenuItem onClick={() => go(`/profile/${address}`)} label="Profile & holdings" />
            <MenuItem
              onClick={() => {
                navigator.clipboard?.writeText(address).catch(() => {});
                toastSuccess("Address copied.");
                setOpen(false);
              }}
              label="Copy address"
            />
            <MenuItem
              onClick={() => {
                disconnect();
                setOpen(false);
              }}
              label="Disconnect"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center rounded-xl px-3 py-2.5 text-left text-sm text-foreground transition-colors hover:bg-surface disabled:opacity-50"
    >
      {label}
    </button>
  );
}
