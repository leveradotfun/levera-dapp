import { NextRequest } from "next/server";

const X_CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const X_REDIRECT_URI = process.env.X_REDIRECT_URI ?? "";
// Simple shared secret for signing the state param (prevents tampering)
const STATE_SECRET = process.env.X_STATE_SECRET ?? "hoodfrenzy-x-oauth-state-secret";

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

export async function GET(req: NextRequest) {
  if (!X_CLIENT_ID || !X_REDIRECT_URI) {
    return new Response("X OAuth not configured. Set X_CLIENT_ID and X_REDIRECT_URI in .env.local", {
      status: 500,
    });
  }

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

  // Encode state + verifier into a signed payload that survives the OAuth redirect
  const payload = `${state}|${codeVerifier}`;
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
