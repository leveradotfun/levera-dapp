"use client";

import { useEffect, useState } from "react";
import { loadXProfile } from "./xAuth";

const STORAGE_PREFIX = "launchpad-frontend:x-profile:";

/// Everything the UI needs to label a wallet that connected X: the handle and the avatar URL
/// (empty when X never returned one). Both come straight from the stored/served XProfile.
export type XIdentity = { username: string; avatar: string };

export type HandleMap = Map<string, XIdentity>; // address lowercase -> identity

function scanLocalHandles(): HandleMap {
  const out: HandleMap = new Map();
  if (typeof window === "undefined") return out;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(STORAGE_PREFIX)) continue;
      const addr = k.slice(STORAGE_PREFIX.length).toLowerCase();
      try {
        const raw = window.localStorage.getItem(k);
        if (!raw) continue;
        const parsed = JSON.parse(raw) as { username?: string; profileImageUrl?: string };
        if (parsed?.username) out.set(addr, { username: parsed.username, avatar: parsed.profileImageUrl ?? "" });
      } catch {
        // ignore malformed entry
      }
    }
  } catch {
    // private mode
  }
  return out;
}

async function fetchRemoteHandles(): Promise<HandleMap> {
  const out: HandleMap = new Map();
  try {
    const res = await fetch("/api/x-profiles", { cache: "no-store" });
    if (!res.ok) return out;
    const json = (await res.json()) as {
      profiles?: Record<string, { username?: string; profileImageUrl?: string }>;
    };
    const profiles = json.profiles ?? {};
    for (const [addr, p] of Object.entries(profiles)) {
      if (p?.username) out.set(addr.toLowerCase(), { username: p.username, avatar: p.profileImageUrl ?? "" });
    }
  } catch {
    // network hiccup -- fallback to local only
  }
  return out;
}

export function getHandleForAddress(address: string, map: HandleMap): string | null {
  return map.get(address.toLowerCase())?.username ?? null;
}

/// Hook that merges a leftover local cache + the Postgres registry.
/// Local is available synchronously on first render so the current user's own
/// trades show @handle immediately; remote fills in other traders.
export function useXHandles(): HandleMap {
  const [map, setMap] = useState<HandleMap>(() => scanLocalHandles());

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const local = scanLocalHandles();
      const remote = await fetchRemoteHandles();
      if (cancelled) return;
      // Merge: remote provides cross-user knowledge, local wins if both exist
      // (local is fresher for the current wallet).
      const merged: HandleMap = new Map(remote);
      for (const [addr, identity] of local) merged.set(addr, identity);
      setMap(merged);
    }

    load();
    // Poll so a handle connected in another tab or by another user appears without reload
    const id = setInterval(load, 10_000);

    // Also refresh when localStorage changes in another tab
    function onStorage(e: StorageEvent) {
      if (e.key?.startsWith(STORAGE_PREFIX)) load();
    }
    window.addEventListener("storage", onStorage);

    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return map;
}

/// Synchronous lookup for a single address from localStorage only.
/// Useful outside React or when a hook is not desired.
export function getLocalHandle(address: string): string | null {
  const p = loadXProfile(address);
  return p?.username ?? null;
}
