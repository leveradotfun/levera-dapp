"use client";

import { useEffect, useState } from "react";

export type TokenMetadata = {
  launch: string;
  imageUrl: string | null;
  website: string | null;
  telegram: string | null;
  discord: string | null;
  twitter: string | null;
  description: string | null;
};

export function useTokenMetadata(launchAddress: string | null) {
  const [meta, setMeta] = useState<TokenMetadata | null>(null);

  useEffect(() => {
    if (!launchAddress) return;
    let cancelled = false;
    fetch(`/api/token-metadata?launch=${encodeURIComponent(launchAddress)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setMeta((j.metadata as TokenMetadata) ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [launchAddress]);

  return meta;
}

export function formatArweaveUrl(url: string | null): string | null {
  if (!url) return null;
  // Our gateway is /api/arweave/<id>, but we also accept https://arweave.net/<id>
  // For display we can use the URL as-is; the gateway will proxy.
  return url;
}
