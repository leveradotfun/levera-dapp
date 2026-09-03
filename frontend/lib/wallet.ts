import { useCallback, useEffect, useState } from "react";
import { useAccount } from "wagmi";
import { DeployedAddresses } from "./chain";
import { TARGETING_TESTNET } from "./chains";
import { fetchEthBalance, fetchTokenBalance, fundEth, mintCbbtc, mintUsdg, mintWeth, WAD } from "./launchpad";

export type WalletBalances = {
  /// Native ETH: gas, and what a WETH-quoted trade spends via msg.value paths.
  eth: bigint;
  /// Wrapped ETH held as an ERC-20. The router deals in this; the user-facing "ETH" button does not.
  weth: bigint;
  usdg: bigint;
  /// The second quote asset, when the deployment has that launchpad. A cbBTC-quoted buy spends
  /// this as a plain ERC-20 (approve-then-pull), never native gas.
  cbbtc: bigint;
};

/// Left behind on MAX so the next tx still has gas. Shared so the header, the trade card, create,
/// and LYC never disagree about how much "ETH" is spendable.
export const GAS_RESERVE = 5n * 10n ** 16n; // 0.05 ETH

export function spendableEth(native: bigint, reserve: bigint = GAS_RESERVE): bigint {
  return native > reserve ? native - reserve : 0n;
}

/// Balance refresh: 4s locally (4 calls, free), 12s against the shared remote RPC.
const REFRESH_MS = TARGETING_TESTNET ? 30_000 : 4_000;

const WETH_TOPUP = 10_000n * WAD;
const USDG_TOPUP = 10_000_000n * WAD;
/// Native gas token, not WETH. Payable entry points -- curve buys, `mintJunior`, `mintWithEth` --
/// spend `msg.value`, so an account with WETH and no ETH cannot make a single one of them.
const ETH_TOPUP = 10_000n * WAD;
/// Only topped up when genuinely low, so a real wallet that already holds ETH is left alone.
const ETH_MIN = 1n * WAD;

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/// The connected wallet's balances, plus an optional local-mock faucet.
///
/// Identity comes from wagmi — there is no built-in test account standing in when nobody is
/// connected. The faucet still mints from the deployer key (mock tokens only); it does not sign
/// as the user.
export function useWallet(addresses: DeployedAddresses | null) {
  const { address, isConnected, connector } = useAccount();
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [funding, setFunding] = useState(false);

  const refresh = useCallback(async () => {
    if (!addresses || !address) {
      setBalances(null);
      return;
    }
    try {
      const [eth, weth, usdg, cbbtc] = await Promise.all([
        fetchEthBalance(address),
        fetchTokenBalance(addresses.weth, address),
        fetchTokenBalance(addresses.usdg, address),
        addresses.cbbtc ? fetchTokenBalance(addresses.cbbtc, address) : Promise.resolve(0n),
      ]);
      setBalances({ eth, weth, usdg, cbbtc });
    } catch {
      // anvil down / stale addresses -- the caller's empty state covers it
    }
  }, [addresses, address]);

  const topUp = useCallback(async () => {
    if (!addresses || !address) return;
    setFunding(true);
    try {
      // Mock-token faucets: the mints are public on the mock ERC-20s, so they work from any
      // connected wallet. cbBTC only exists when the deployment has that second launchpad.
      // Native gas is different per target: on the local fork the shared admin key sends it;
      // on testnet there is no funded admin key, so gas comes from the real faucet and the
      // native top-up is skipped rather than failing the whole button.
      if (!TARGETING_TESTNET) {
        const eth = await fetchEthBalance(address);
        if (eth < ETH_MIN) await fundEth(address, ETH_TOPUP);
      }
      await mintWeth(addresses, address, WETH_TOPUP);
      await mintUsdg(addresses, address, USDG_TOPUP);
      await mintCbbtc(addresses, address, 10n * 10n ** 8n);
      await refresh();
    } finally {
      setFunding(false);
    }
  }, [addresses, address, refresh]);

  useEffect(() => {
    if (!addresses || !address) {
      setBalances(null);
      return;
    }
    refresh();
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [addresses, address, refresh]);

  return {
    address: address ?? null,
    isConnected,
    connectorName: connector?.name ?? null,
    balances,
    refresh,
    topUp,
    funding,
  };
}
