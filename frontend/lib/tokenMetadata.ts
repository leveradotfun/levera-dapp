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

/// Images for a whole set of launches, fetched in one batched call and keyed by lowercase
/// launch address. Surfaces with many coins (Explore grid/table, profile positions) use this
/// to render each coin's pinned artwork instead of the hash-emoji fallback.
export function useTokenImages(launchAddresses: string[]): Map<string, string> {
  const joined = launchAddresses.map((a) => a.toLowerCase()).sort().join(",");
  const [images, setImages] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!joined) {
      setImages(new Map());
      return;
    }
    let cancelled = false;
    fetch(`/api/token-metadata?launches=${joined}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const [addr, m] of Object.entries(
          (j.metadatas ?? {}) as Record<string, { imageUrl?: string | null }>,
        )) {
          if (m?.imageUrl) map.set(addr.toLowerCase(), m.imageUrl);
        }
        setImages(map);
      })
      .catch(() => {
        // offline / API hiccup -- avatars fall back to the hash emoji
      });
    return () => {
      cancelled = true;
    };
  }, [joined]);

  return images;
}
