"use client";

import { useCallback, useEffect, useState } from "react";
import {
  XProfile,
  loadXProfile,
  saveXProfile,
  removeXProfile,
  syncProfileToServer,
  removeProfileFromServer,
  linkMessage,
  unlinkMessage,
} from "./xAuth";
import { getActiveSigner } from "./activeSigner";

/// Hook to manage X (Twitter) social login state for a wallet address.
/// Reads/writes localStorage. On mount, checks for an ?x_connected= query param
/// (set by the OAuth callback) and persists the profile.
///
/// Ownership binding: the OAuth result only names the X account — it says nothing about which
/// wallet it belongs to. So the link is completed by the WALLET signing a message over
/// `wallet + username + x-id`, and that signature rides along on every server sync. No
/// signature, no registry write — otherwise anyone could bind any X identity to any wallet.
export function useXAuth(walletAddress: string | null) {
  const [profile, setProfile] = useState<XProfile | null>(null);

  // Load from localStorage on mount and when address changes
  useEffect(() => {
    if (!walletAddress) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    const existing = loadXProfile(walletAddress);
    setProfile(existing);
    // Backfill the server registry — only profiles that carry their ownership signature.
    if (existing?.linkSignature) syncProfileToServer(walletAddress, existing);

    // Check for OAuth callback data in URL
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("x_connected");
    const error = params.get("x_error");

    if (connected && walletAddress) {
      (async () => {
        try {
          const parsed = JSON.parse(atob(connected)) as { id?: string; name?: string; username?: string; profileImageUrl?: string };
          if (!parsed.username) throw new Error("malformed profile");
          // Sign with the wallet that is connected RIGHT NOW, and refuse if it is not the
          // wallet the link will be filed under — otherwise a wallet switched mid-OAuth would
          // file someone's X identity under the wrong address.
          const { signer, address } = await getActiveSigner();
          if (cancelled) return;
          if (address.toLowerCase() !== walletAddress.toLowerCase()) {
            console.warn("X connect aborted: active wallet changed during OAuth");
            window.history.replaceState({}, "", window.location.pathname);
            return;
          }
          const username = parsed.username.replace(/^@/, "");
          const linkSignature = await signer.signMessage(
            linkMessage(walletAddress, username, parsed.id ?? ""),
          );
          if (cancelled) return;
          const newProfile: XProfile = {
            id: parsed.id ?? "",
            name: parsed.name ?? "",
            username,
            profileImageUrl: parsed.profileImageUrl ?? "",
            connectedAt: Date.now(),
            linkSignature,
          };
          saveXProfile(walletAddress, newProfile);
          syncProfileToServer(walletAddress, newProfile);
          setProfile(newProfile);
        } catch (e) {
          // signature rejected or malformed data — no signed link, no save
          console.warn("X connect did not complete:", e);
        } finally {
          if (!cancelled) window.history.replaceState({}, "", window.location.pathname);
        }
      })();
    }

    if (error) {
      console.warn("X OAuth error:", error);
      window.history.replaceState({}, "", window.location.pathname);
    }

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  const connect = useCallback(() => {
    // Carry the current page through the OAuth round trip so the callback returns here instead
    // of always landing on /profile -- see app/api/auth/x/connect's sanitizeReturnTo.
    const returnTo = window.location.pathname + window.location.search;
    window.location.href = `/api/auth/x/connect?returnTo=${encodeURIComponent(returnTo)}`;
  }, []);

  const disconnect = useCallback(() => {
    if (!walletAddress) return;
    // Unlinking is signed too: without ownership proof, a DELETE would let anyone strip any
    // wallet's identity from the public registry.
    (async () => {
      try {
        const { signer, address } = await getActiveSigner();
        if (address.toLowerCase() !== walletAddress.toLowerCase()) return;
        const signature = await signer.signMessage(unlinkMessage(walletAddress));
        removeXProfile(walletAddress);
        removeProfileFromServer(walletAddress, signature);
        setProfile(null);
      } catch {
        // refused signature — keep the existing link untouched
      }
    })();
  }, [walletAddress]);

  return { profile, connect, disconnect };
}
