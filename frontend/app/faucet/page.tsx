"use client";

import { useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import { useAppState } from "@/lib/appState";
import { useWallet } from "@/lib/wallet";
import { TX_TIMEOUT_MS, withTimeout } from "@/lib/txTimeout";
import { getActiveSigner, withActiveSigner } from "@/lib/activeSigner";
import ConnectWalletButton from "@/components/ConnectWalletButton";
import TokenIcon from "@/components/TokenIcon";
import { humanizeError, toastError, toastSuccess } from "@/lib/toast";
import { formatWad } from "@/lib/launchpad";

/// The daily faucet. Mock tokens (cbBTC / WETH / USDG) are minted by the server; ETH is paid out
/// of a COMMUNITY POT — a wallet other users contribute their excess gas to — because native ETH
/// cannot be minted, only shared. One claim per asset per UTC day, enforced server-side.

type Asset = "cbbtc" | "weth" | "usdg" | "eth";

type FaucetStatus = {
  network: string;
  faucetAddress: string;
  potEth: string;
  tokens: Record<Asset, string>;
  limits: Record<Asset, string>;
  claimedToday: Record<Asset, string>;
};

const CARDS: Array<{ asset: Asset; label: string; onChainSymbol: string; daily: string; blurb: string; accent: string; decimals: number; testnetAddress: string }> = [
  { asset: "cbbtc", label: "cbBTC", onChainSymbol: "cbBTC", daily: "0.5", blurb: "Launch and trade cbBTC-quoted coins.", accent: "#f7931a", decimals: 8, testnetAddress: "0x056Fe96EAB78d0a89e7E26a89724578Ee721c191" },
  { asset: "weth", label: "WETH", onChainSymbol: "mWETH", daily: "5", blurb: "Launch WETH-quoted coins and trade.", accent: "#627eea", decimals: 18, testnetAddress: "0x9504a9946Efe6858f8cbA6e6Ea0efBb9105592be" },
  { asset: "usdg", label: "USDG", onChainSymbol: "mUSDG", daily: "10,000", blurb: "Mint LYC in the Earn Pool.", accent: "#22c55e", decimals: 18, testnetAddress: "0xe37F7675aE587b9d6EAB0f443E41fcF48866dA28" },
  { asset: "eth", label: "ETH", onChainSymbol: "ETH", daily: "0.001", blurb: "Gas money — paid from the community pot.", accent: "#a1a1aa", decimals: 18, testnetAddress: "" },
];

async function addTokenToMetaMask(tokenAddress: string, symbol: string, decimals: number, image?: string) {
  const eth = (window as any).ethereum;
  if (!eth) {
    throw new Error("No wallet detected — install MetaMask or another EIP-1193 wallet.");
  }

  // Handle multi-provider wallets (e.g. Coinbase Wallet injects multiple providers)
  const provider = eth.providers?.length ? eth.providers[0] : eth;
  if (!provider?.request) {
    throw new Error("No wallet provider found — try refreshing the page.");
  }

  // Ensure we're on Robinhood Testnet (46630) before adding token
  const targetChainId = "0xb626"; // 46630 hex
  let currentChain: string | null = null;
  try { currentChain = await provider.request({ method: "eth_chainId" }); } catch {}

  if (currentChain !== targetChainId) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: targetChainId }] });
    } catch (switchErr: any) {
      const code = switchErr?.code ?? switchErr?.data?.code;
      if (code === 4902) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: targetChainId,
            chainName: "Robinhood Chain Testnet",
            nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://rpc.testnet.chain.robinhood.com"],
            blockExplorerUrls: ["https://explorer.testnet.chain.robinhood.com"],
          }],
        });
      } else if (code === 4001) {
        throw new Error("Chain switch rejected — approve in wallet first.");
      } else {
        throw new Error(`Chain switch failed (code ${code ?? "unknown"}). Add chain 46630 manually in your wallet.`);
      }
    }
  }

  // EIP-55 checksum the address
  const checksummed = ethers.getAddress(tokenAddress);

  try {
    const added = await provider.request({
      method: "wallet_watchAsset",
      params: { type: "ERC20", options: { address: checksummed, symbol, decimals, image: image ?? "" } },
    });
    if (!added) throw new Error("Token was not added — it may already be tracked.");
    return true;
  } catch (e: any) {
    const msg = typeof e === "string" ? e : e?.message ?? String(e);
    if (/already/i.test(msg)) return true;
    throw new Error(msg && msg !== "{}" ? msg : `Could not add ${symbol}. Add it manually with address ${checksummed}.`);
  }
}

export default function FaucetPage() {
  const { addresses } = useAppState();
  const wallet = useWallet(addresses);
  const [status, setStatus] = useState<FaucetStatus | null>(null);
  const [busy, setBusy] = useState<Asset | null>(null);
  const [contributeAmt, setContributeAmt] = useState("");
  const [contributing, setContributing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addedTokens, setAddedTokens] = useState<Set<string>>(new Set());

  // Load persisted "added" state from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("levera-added-tokens");
      if (stored) setAddedTokens(new Set(JSON.parse(stored)));
    } catch {}
  }, []);

  const refresh = useCallback(async () => {
    try {
      const q = wallet.address ? `?address=${wallet.address}` : "";
      const r = await fetch(`/api/faucet${q}`, { cache: "no-store" });
      if (r.ok) setStatus(await r.json());
    } catch {
      // the page still renders limits from the static card list
    }
  }, [wallet.address]);

  useEffect(() => {
    void refresh();
    const id = setInterval(refresh, 20_000);
    return () => clearInterval(id);
  }, [refresh]);

  const potEth = status ? Number(ethers.formatUnits(BigInt(status.potEth || "0"), 18)) : 0;
  const claimed = (a: Asset) => Boolean(status?.claimedToday?.[a]);

  async function claim(asset: Asset, label: string) {
    if (!wallet.address) return;
    setBusy(asset);
    setError(null);
    try {
      // Prove the claim: the connected wallet signs today's message and the server recovers the
      // signer from it -- the API rejects a claim for any address that did not sign.
      const day = new Date().toISOString().slice(0, 10);
      const { signer } = await getActiveSigner();
      const message = `Levera faucet claim\n${asset} ${day}\n${wallet.address.toLowerCase()}`;
      const signature = await signer.signMessage(message);
      const r = await fetch("/api/faucet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: wallet.address, asset, signature }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body?.error ?? `Claim failed (${r.status})`);
      toastSuccess(`Claimed ${CARDS.find((c) => c.asset === asset)?.daily} ${label}.`);
      await refresh();
      wallet.refresh();
    } catch (e) {
      setError(humanizeError(e, "Claim failed."));
      toastError(e, "Faucet claim failed.");
    } finally {
      setBusy(null);
    }
  }

  async function contribute() {
    if (!addresses) return;
    let amount: bigint;
    try {
      amount = ethers.parseEther(contributeAmt || "0");
    } catch {
      setError("Contribution isn't a valid ETH amount.");
      return;
    }
    if (amount <= 0n) {
      setError("Enter an ETH amount to contribute.");
      return;
    }
    if (!status?.faucetAddress) {
      setError("Faucet pot not loaded yet.");
      return;
    }
    setContributing(true);
    setError(null);
    try {
      await withTimeout(
        withActiveSigner(async ({ signer, address }) => {
          const balance = await (signer.provider as ethers.Provider).getBalance(address);
          // Keep a little back for the contribution's own gas.
          if (amount > balance - ethers.parseEther("0.0005")) {
            throw new Error("That would leave you without gas. Keep a little ETH back.");
          }
          const tx = await signer.sendTransaction({ to: status.faucetAddress, value: amount });
          return tx.wait();
        }),
        TX_TIMEOUT_MS,
        "Contribute",
      );
      toastSuccess(`Contributed ${contributeAmt} ETH to the community pot. Thank you.`);
      setContributeAmt("");
      await refresh();
    } catch (e) {
      setError(humanizeError(e, "Contribution failed."));
      toastError(e, "Contribution failed.");
    } finally {
      setContributing(false);
    }
  }

  const userBalance = (a: Asset): string => {
    const b = wallet.balances;
    if (!b) return "—";
    if (a === "eth") return Number(ethers.formatUnits(b.eth, 18)).toFixed(4);
    if (a === "cbbtc") return Number(ethers.formatUnits(b.cbbtc, 8)).toFixed(4);
    if (a === "weth") return Number(ethers.formatUnits(b.weth, 18)).toFixed(2);
    return Number(ethers.formatUnits(b.usdg, 18)).toFixed(0);
  };

  return (
    <div className="mx-auto w-full max-w-4xl py-6 space-y-5">
      <div>
        <h1 className="text-lg font-bold text-foreground">Faucet</h1>
        <p className="text-xs text-muted mt-0.5">
          One claim per asset per UTC day. Mock tokens are minted by the faucet; ETH comes from a
          community pot that other users top up.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-red/20 bg-red/5 p-2.5 text-xs text-red">{error}</div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {CARDS.map((card) => {
          const done = claimed(card.asset);
          return (
            <div key={card.asset} className="rounded-2xl border border-border bg-card p-5 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TokenIcon symbol={card.label} size={22} />
                  <span className="text-sm font-semibold text-foreground">{card.label}</span>
                </div>
                <span className="font-mono text-xs text-accent">{card.daily} / day</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted flex-1">{card.blurb}</p>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">
                  Yours: <span className="font-mono text-secondary">{userBalance(card.asset)}</span>
                </span>
                <div className="flex items-center gap-2">
                  {card.asset !== "eth" && (status?.tokens?.[card.asset] || card.testnetAddress) ? (
                    (() => {
                      const liveAddress = status?.tokens?.[card.asset] || card.testnetAddress;
                      return addedTokens.has(liveAddress) ? (
                        <span className="text-[10px] text-green font-medium">Added</span>
                      ) : (
                        <button
                          onClick={async () => {
                            try {
                              const added = await addTokenToMetaMask(liveAddress, card.onChainSymbol, card.decimals);
                              if (added) {
                                const next = new Set(addedTokens);
                                next.add(liveAddress);
                                setAddedTokens(next);
                                localStorage.setItem("levera-added-tokens", JSON.stringify([...next]));
                                toastSuccess(`${card.label} added to wallet.`);
                              }
                            } catch (e) {
                              toastError(e, "Failed to add token.");
                            }
                          }}
                          className="text-[10px] text-muted hover:text-foreground transition-colors"
                          title={`Add ${card.onChainSymbol} to MetaMask (testnet)`}
                        >
                          + wallet
                        </button>
                      );
                    })()
                  ) : null}
                  {!wallet.isConnected ? (
                    <ConnectWalletButton label="Connect" />
                  ) : (
                  <button
                    onClick={() => claim(card.asset, card.label)}
                    disabled={done || busy !== null}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                      done
                        ? "bg-surface text-muted cursor-default"
                        : "bg-accent text-accent-ink hover:opacity-90 disabled:opacity-50"
                    }`}
                  >
                    {busy === card.asset ? "Claiming…" : done ? "Claimed today" : `Claim ${card.daily} ${card.label}`}
                  </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Community ETH pot */}
      <div className="rounded-2xl border border-border bg-card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-foreground">Community ETH pot</div>
            <p className="text-[11px] leading-relaxed text-muted mt-0.5">
              Native ETH can&apos;t be minted — it can only be shared. Contribute gas you don&apos;t
              need and anyone out of ETH can claim 0.001/day from the pot. Claims stop when it runs
              dry, so top-ups keep the faucet alive.
            </p>
          </div>
          <div className="text-right shrink-0 ml-4">
            <div className="text-[10px] uppercase tracking-wide text-muted">Pot balance</div>
            <div className="font-mono text-lg font-bold text-foreground">{potEth.toFixed(4)} ETH</div>
          </div>
        </div>

        {status?.faucetAddress ? (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <span className="text-[10px] uppercase tracking-wide text-muted shrink-0">Pot address</span>
            <span className="font-mono text-xs text-secondary truncate flex-1">{status.faucetAddress}</span>
            <button
              type="button"
              onClick={() => navigator.clipboard.writeText(status.faucetAddress).then(() => toastSuccess("Pot address copied.")).catch(() => {})}
              className="text-[10px] text-muted hover:text-foreground shrink-0"
            >
              copy
            </button>
          </div>
        ) : null}

        {wallet.isConnected ? (
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <input
                value={contributeAmt}
                onChange={(e) => setContributeAmt(e.target.value)}
                inputMode="decimal"
                placeholder="0.001"
                className="w-full bg-transparent text-sm font-mono text-foreground outline-none"
              />
              <span className="shrink-0 font-mono text-xs text-muted">
                ETH · yours {userBalance("eth")}
              </span>
            </div>
            <button
              onClick={contribute}
              disabled={contributing || !contributeAmt}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:opacity-90 disabled:opacity-50"
            >
              {contributing ? "Sending…" : "Contribute"}
            </button>
          </div>
        ) : (
          <ConnectWalletButton label="Connect wallet to contribute" />
        )}
      </div>

      {status ? (
        <p className="text-[11px] text-muted">
          Faucet network: {status.network === "robinhood-testnet" ? "Robinhood Chain Testnet (46630)" : "local fork"}.
          Limits reset at midnight UTC. The ETH pot currently holds {potEth.toFixed(4)} ETH — roughly{" "}
          {Math.floor(potEth / 0.001).toLocaleString()} daily claims until it needs a top-up.
        </p>
      ) : null}
    </div>
  );
}
