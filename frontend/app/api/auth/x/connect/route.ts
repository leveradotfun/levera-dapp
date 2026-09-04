import { NextRequest } from "next/server";

const X_CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const X_REDIRECT_URI = process.env.X_REDIRECT_URI ?? "";
// Simple shared secret for signing the state param (prevents tampering)
const STATE_SECRET = process.env.X_STATE_SECRET ?? "levera-x-oauth-state-secret";

async function hmacSign(data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(STATE_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Only a same-origin relative path may ride along in the state -- anything else (a full URL, a
// protocol-relative "//evil.com" or "/\evil.com", an embedded "://") would turn the callback's
// final redirect into an open redirect, since the callback trusts whatever comes back out of the
// signed state without re-checking the origin.
function sanitizeReturnTo(raw: string | null): string {
  if (!raw) return "/profile";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.includes("://")) {
    return "/profile";
  }
  return raw;
}

export async function GET(req: NextRequest) {
  if (!X_CLIENT_ID || !X_REDIRECT_URI) {
    return new Response("X OAuth not configured. Set X_CLIENT_ID and X_REDIRECT_URI in .env.local", {
      status: 500,
    });
  }

  const returnTo = sanitizeReturnTo(req.nextUrl.searchParams.get("returnTo"));

  // CSRF state
  const stateBytes = new Uint8Array(16);
  crypto.getRandomValues(stateBytes);
  const state = btoa(String.fromCharCode(...stateBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // PKCE code verifier
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  // Encode state + verifier + the page to return to into a signed payload that survives the
  // OAuth redirect. Signed together with everything else so returnTo can't be tampered with
  // independently of the CSRF check.
  const payload = `${state}|${codeVerifier}|${encodeURIComponent(returnTo)}`;
  const sig = await hmacSign(payload);
  const signedState = btoa(`${payload}|${sig}`)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: X_CLIENT_ID,
    redirect_uri: X_REDIRECT_URI,
    scope: "tweet.read users.read offline.access",
    state: signedState,
    code_challenge: codeVerifier,
    code_challenge_method: "plain",
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://twitter.com/i/oauth2/authorize?${params.toString()}`,
    },
  });
}
