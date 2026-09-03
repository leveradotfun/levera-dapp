"use client";

import { useEffect, useState } from "react";
import { explorerAddressUrl, explorerTxUrl, ROBINHOOD_MAINNET_ID } from "@/lib/chains";
import { getProvider } from "@/lib/signers";

/// Links a hash or address to the Robinhood Chain explorer.
///
/// The chain id is read from the RPC the app is actually talking to, rather than assumed: running
/// against the local mainnet fork, against the public testnet, and against mainnet proper are all
/// normal, and each has its own explorer. Hardcoding one — this previously pointed at
/// etherscan.io, which has never had any of these transactions — produces links that look right
/// and always 404.
function useChainId(): number {
  const [id, setId] = useState(ROBINHOOD_MAINNET_ID);
  useEffect(() => {
    let cancelled = false;
    getProvider()
      .getNetwork()
      .then((n) => {
        if (!cancelled) setId(Number(n.chainId));
      })
      .catch(() => {
        // unreachable RPC -- the mainnet default is the sane guess
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return id;
}

export function TxLink({ hash, className }: { hash: string; className?: string }) {
  const chainId = useChainId();
  if (!hash) return null;
  return (
    <a
      href={explorerTxUrl(chainId, hash)}
      target="_blank"
      rel="noopener noreferrer"
      title={hash}
      className={className ?? "font-mono text-xs text-accent hover:underline"}
    >
      {hash.slice(0, 6)}…
    </a>
  );
}

export function AddressLink({
  address,
  label,
  className,
}: {
  address: string;
  label?: string;
  className?: string;
}) {
  const chainId = useChainId();
  if (!address) return null;
  return (
    <a
      href={explorerAddressUrl(chainId, address)}
      target="_blank"
      rel="noopener noreferrer"
      title={address}
      className={className ?? "font-mono text-xs text-accent hover:underline"}
    >
      {label ?? `${address.slice(0, 6)}…${address.slice(-4)}`}
    </a>
  );
}
