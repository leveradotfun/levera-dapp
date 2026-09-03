export type XProfile = {
  id: string;
  name: string;
  username: string;
  profileImageUrl: string;
  connectedAt: number;
};

const STORAGE_PREFIX = "launchpad-frontend:x-profile:";

function key(walletAddress: string): string {
  return `${STORAGE_PREFIX}${walletAddress.toLowerCase()}`;
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
  // Fire-and-forget: the local save already succeeded, remote is best-effort
  fetch("/api/x-profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletAddress, profile }),
  }).catch(() => {});
}

export function removeProfileFromServer(walletAddress: string) {
  if (typeof window === "undefined") return;
  fetch("/api/x-profiles", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address: walletAddress }),
  }).catch(() => {});
}
