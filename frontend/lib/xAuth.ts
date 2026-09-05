export type XProfile = {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string;
  connectedAt: number;
  /// personal_sign signature over linkMessage() — proof this wallet owns this X link. Every
  /// server sync carries it; the API refuses unsigned writes. Absent only on profiles saved
  /// before the signature requirement, which are local-only until re-linked.
  linkSignature?: string;
};

const STORAGE_PREFIX = "launchpad-frontend:x-profile:";

function key(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}`;
}

/// The canonical wallet->X binding message. MUST match the server's xLinkMessage() byte for
/// byte — the signature is the only thing binding this wallet to this exact username/id, so a
/// drifted format would silently break every sync.
export function linkMessage(walletAddress: string, username: string, xId: string): string {
  return `Levera X link\nwallet: ${walletAddress.toLowerCase()}\nusername: @${username.replace(/^@/, "")}\nid: ${xId}`;
}

export function unlinkMessage(walletAddress: string): string {
  return `Levera X unlink\nwallet: ${walletAddress.toLowerCase()}`;
}

export function loadXProfile(walletAddress: string): XProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key(walletAddress));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function saveXProfile(walletAddress: string, profile: XProfile) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key(walletAddress), JSON.stringify(profile));
  } catch {
    // localStorage full or unavailable
  }
}

export function removeXProfile(walletAddress: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(key(walletAddress));
  } catch {
    // best effort
  }
}

export function syncProfileToServer(walletAddress: string, profile: XProfile) {
  if (typeof window === "undefined") return;
  // Unsigned profiles cannot be synced: the API refuses them, and re-signing here silently is
  // not possible (signing needs the wallet's active approval). The profile stays local-only.
  if (!profile.linkSignature) return;
  // Fire-and-forget: the local save already succeeded, remote is best-effort
  fetch("/api/x-profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: walletAddress,
      profile: {
        id: profile.id,
        name: profile.name,
        username: profile.username,
        profileImageUrl: profile.profileImageUrl,
        connectedAt: profile.connectedAt,
      },
      signature: profile.linkSignature,
    }),
  }).catch(() => {});
}

export function removeProfileFromServer(walletAddress: string, signature?: string) {
  if (typeof window === "undefined") return;
  if (!signature) return;
  fetch("/api/x-profiles", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletAddress, signature }),
  }).catch(() => {});
}
