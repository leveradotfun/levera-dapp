"use client";

import { useCallback, useEffect, useState } from "react";
import { XProfile, loadXProfile, saveXProfile, removeXProfile, syncProfileToServer, removeProfileFromServer } from "./xAuth";

/// Hook to manage X (Twitter) social login state for a wallet address.
/// Reads/writes localStorage. On mount, checks for an ?x_connected= query param
/// (set by the OAuth callback) and persists the profile.
export function useXAuth(walletAddress: string | null) {
  const [profile, setProfile] = useState<XProfile | null>(null);

  // Load from localStorage on mount and when address changes
  useEffect(() => {
    if (!walletAddress) {
      setProfile(null);
      return;
    }
    const existing = loadXProfile(walletAddress);
    setProfile(existing);
    // Backfill server registry for handles that were saved before the registry existed
    if (existing) syncProfileToServer(walletAddress, existing);

    // Check for OAuth callback data in URL
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("x_connected");
    const error = params.get("x_error");

    if (connected && walletAddress) {
      try {
        const parsed = JSON.parse(atob(connected));
        const newProfile: XProfile = {
          ...parsed,
          connectedAt: Date.now(),
        };
        saveXProfile(walletAddress, newProfile);
        syncProfileToServer(walletAddress, newProfile);
        setProfile(newProfile);
        // Clean the URL
        window.history.replaceState({}, "", window.location.pathname);
      } catch {
        // malformed data — ignore
      }
    }

    if (error) {
      console.warn("X OAuth error:", error);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, [walletAddress]);

  const connect = useCallback(() => {
    window.location.href = "/api/auth/x/connect";
  }, []);

  const disconnect = useCallback(() => {
    if (!walletAddress) return;
    removeXProfile(walletAddress);
    removeProfileFromServer(walletAddress);
    setProfile(null);
  }, [walletAddress]);

  return { profile, connect, disconnect };
}
