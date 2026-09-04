import { ethers } from "ethers";
import { handleFollowsGet, handleFollowsMutate, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handleFollowsGet);

const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/// Follows are writes to a public social graph, so the body's "who" is not taken at face value:
/// the wallet signs the action and the server recovers the signer. The signed message binds the
/// target, the action, and a timestamp so a captured signature is neither replayable for another
/// target nor forever.
const FRESH_MS = 10 * 60 * 1000;

export const POST = wrap(async (req: Request) => {
  const b = (await req.json()) as Record<string, unknown>;
  const follower = typeof b.follower === "string" ? b.follower.toLowerCase() : "";
  const target = typeof b.target === "string" ? b.target.toLowerCase() : "";
  const action = b.action === "follow" || b.action === "unfollow" ? b.action : "";
  const message = typeof b.message === "string" ? b.message : "";
  const signature = typeof b.signature === "string" ? b.signature : "";
  if (!ADDRESS_RE.test(follower) || !ADDRESS_RE.test(target) || !action || !message || !signature) {
    return Response.json({ error: "follower, target, action, message, signature required" }, { status: 400 });
  }
  if (follower === target) return Response.json({ error: "cannot follow yourself" }, { status: 400 });

  const [header, scope, time] = message.split("\n");
  const ts = Number(time);
  if (header !== "Levera" || scope !== `${action} ${target}` || !Number.isInteger(ts)) {
    return Response.json({ error: "message mismatch" }, { status: 400 });
  }
  const age = Date.now() - ts;
  if (age > FRESH_MS || age < -60_000) {
    return Response.json({ error: "signature expired" }, { status: 400 });
  }

  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return Response.json({ error: "invalid signature" }, { status: 400 });
  }
  if (recovered !== follower) {
    return Response.json({ error: "signer is not the follower" }, { status: 401 });
  }

  await handleFollowsMutate(follower, target, action);
  return Response.json({ ok: true });
});
