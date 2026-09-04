export const runtime = "edge";

// Fronts a paid/rate-limited RPC (Goldsky Edge, or anything else with a key in the URL) so the
// browser never sees it. `NEXT_PUBLIC_*` vars are inlined into the client bundle at build time --
// there is no way to point NEXT_PUBLIC_RPC_URL straight at an authenticated endpoint without
// shipping the key to every visitor. This route is the app's own origin instead: wagmi's testnet
// transport (frontend/lib/wagmi.ts) points at it via NEXT_PUBLIC_RPC_URL, and the real upstream
// URL lives only in this server-side env var. Edge runtime so the extra hop stays cheap and lands
// near the visitor rather than cold-starting a Node lambda per request.
//
// Falls back to the plain public RPC when TESTNET_RPC_PROXY_URL is unset, so local dev and a
// fresh deploy without the var configured still work -- just without the speed benefit.
const UPSTREAM = process.env.TESTNET_RPC_PROXY_URL || "https://rpc.testnet.chain.robinhood.com";

export async function POST(request: Request) {
  const body = await request.text();
  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": "application/json" },
  });
}
