"use client";

import { getActiveSigner } from "./activeSigner";
import { apiGet, apiPost } from "./remote";

/// The on-platform social graph. Identity is the wallet address, not the X account: follows work
/// for every wallet, connected to Twitter or not.

export type FollowInfo = {
  followers: number;
  following: number;
  viewerFollows: boolean;
};

export async function fetchFollowInfo(target: string, viewer: string | null): Promise<FollowInfo> {
  const q = new URLSearchParams({ address: target });
  if (viewer) q.set("viewer", viewer);
  return (
    (await apiGet<FollowInfo>(`/api/follows?${q.toString()}`)) ?? { followers: 0, following: 0, viewerFollows: false }
  );
}

/// Signs the action with the connected wallet and posts it. The server recovers the signer from
/// the signature, so nobody can follow "as" someone else by forging a request body.
export async function setFollow(target: string, action: "follow" | "unfollow"): Promise<void> {
  const { signer, address } = await getActiveSigner();
  const message = `Levera\n${action} ${target.toLowerCase()}\n${Date.now()}`;
  const signature = await signer.signMessage(message);
  const ok = await apiPost("/api/follows", {
    follower: address,
    target: target.toLowerCase(),
    action,
    message,
    signature,
  });
  if (!ok) throw new Error("Could not save the follow — try again.");
}
