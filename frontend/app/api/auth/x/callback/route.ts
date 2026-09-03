import { NextRequest } from "next/server";

const X_CLIENT_ID = process.env.X_CLIENT_ID ?? "";
const X_CLIENT_SECRET = process.env.X_CLIENT_SECRET ?? "";
const X_REDIRECT_URI = process.env.X_REDIRECT_URI ?? "";
const STATE_SECRET = process.env.X_STATE_SECRET ?? "levera-x-oauth-state-secret";

async function hmacVerify(data: string, sig: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(STATE_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    return crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode(data));
  } catch {
    return false;
  }
}

function redirect(url: string) {
  return new Response(null, { status: 302, headers: { Location: url } });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const signedState = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Use x-forwarded-host (set by ngrok/proxies) to get the real public host,
  // since req.url may resolve to localhost internally.
  const forwardedHost = req.headers.get("x-forwarded-host");
  const host = forwardedHost || url.host;
  const base = `${url.protocol}//${host}`;

  if (error) {
    return redirect(`${base}/profile?x_error=${error}`);
  }

  if (!signedState) {
    return redirect(`${base}/profile?x_error=missing_state`);
  }

  // Decode the signed state to recover the original state + code verifier
  let originalState: string;
  let codeVerifier: string;
  try {
    const decoded = atob(signedState.replace(/-/g, "+").replace(/_/g, "/"));
    const parts = decoded.split("|");
    if (parts.length !== 3) throw new Error("bad format");
    [originalState, codeVerifier, ] = parts;
    const sig = parts[2];

    // Verify HMAC
    const valid = await hmacVerify(`${originalState}|${codeVerifier}`, sig);
    if (!valid) {
      return redirect(`${base}/profile?x_error=invalid_signature`);
    }
  } catch {
    return redirect(`${base}/profile?x_error=bad_state`);
  }

  if (!code) {
    return redirect(`${base}/profile?x_error=missing_code`);
  }

  if (!X_CLIENT_ID || !X_CLIENT_SECRET || !X_REDIRECT_URI) {
    return redirect(`${base}/profile?x_error=not_configured`);
  }

  try {
    // Exchange authorization code for access token
    const tokenRes = await fetch("https://api.twitter.com/2/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${X_CLIENT_ID}:${X_CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: X_REDIRECT_URI,
        code_verifier: codeVerifier,
      }).toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error("X token exchange failed:", tokenRes.status, errBody);
      return redirect(`${base}/profile?x_error=token_exchange_failed`);
    }

    const tokenData = await tokenRes.json();
    const accessToken: string = tokenData.access_token;

    // Fetch user profile
    const userRes = await fetch(
      "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (!userRes.ok) {
      return redirect(`${base}/profile?x_error=profile_fetch_failed`);
    }

    const userData = await userRes.json();
    const user = userData.data;

    // Build profile and pass to client via base64 query param
    const profile = {
      id: user.id,
      name: user.name,
      username: user.username,
      profileImageUrl: user.profile_image_url?.replace("_normal", "_400x400") ?? "",
    };

    const encoded = btoa(JSON.stringify(profile));
    return redirect(`${base}/profile?x_connected=${encoded}`);
  } catch (e) {
    console.error("X OAuth callback error:", e);
    return redirect(`${base}/profile?x_error=internal`);
  }
}
