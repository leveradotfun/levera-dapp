import {
  addFollow,
  listTrending,
  applyTrade,
  deleteXProfile,
  followCounts,
  insertPricePoints,
  insertRebalance,
  isFollowing,
  listLedger,
  listLedgerByFactory,
  listFollows,
  listLycNavSamples,
  listPricePoints,
  listRebalances,
  listXProfiles,
  removeFollow,
  upsertLycNavSample,
  upsertXProfile,
  wipeAllSessionData,
  wipeFactory,
  type LycNavSample,
  type PricePoint,
  type RebalanceEvent,
  type TradeInput,
  type XProfile,
} from "./store";
import { ethers } from "ethers";

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

export function wrap(fn: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await fn(req);
    } catch (e) {
      console.error("[db]", e);
      return json({ error: "db" }, 500);
    }
  };
}

function factoryOf(url: URL): string {
  return (url.searchParams.get("factory") ?? "").trim();
}

function launchOf(url: URL): string {
  return (url.searchParams.get("launch") ?? "").trim();
}

/// LYC NAV history. Both apps POST here on the same 5-minute bucket grid; the console's bot runs
/// feed the same series the public Earn page reads its 24h/7d APY from.
export async function handleLycNavGet(req: Request): Promise<Response> {
  const factory = factoryOf(new URL(req.url));
  if (!factory) return json({ error: "factory required" }, 400);
  const samples = await listLycNavSamples(factory);
  return json({ samples });
}

export async function handleLycNavPost(req: Request): Promise<Response> {
  const body = (await req.json()) as { factory?: string; sample?: LycNavSample; samples?: LycNavSample[] };
  const factory = body.factory?.trim();
  if (!factory) return json({ error: "factory required" }, 400);
  const samples = body.samples ?? (body.sample ? [body.sample] : []);
  for (const s of samples) {
    if (!s || typeof s.t !== "number" || typeof s.nav !== "number") continue;
    await upsertLycNavSample(factory, s);
  }
  return json({ ok: true, n: samples.length });
}

export async function handlePriceGet(req: Request): Promise<Response> {
  const launch = launchOf(new URL(req.url));
  if (!launch) return json({ error: "launch required" }, 400);
  const points = await listPricePoints(launch);
  return json({ points });
}

export async function handleTrendingGet(): Promise<Response> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const rows = await listTrending(cutoff);
  return json({ rows });
}

export async function handlePricePost(req: Request): Promise<Response> {
  const body = (await req.json()) as { launch?: string; factory?: string; points?: PricePoint[] };
  const launch = body.launch?.trim();
  const factory = body.factory?.trim() ?? "";
  if (!launch) return json({ error: "launch required" }, 400);
  await insertPricePoints(launch, factory, body.points ?? []);
  return json({ ok: true, n: body.points?.length ?? 0 });
}

export async function handleLedgerGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const launch = launchOf(url);
  const factory = factoryOf(url);
  if (factory) return json({ rows: await listLedgerByFactory(factory) });
  if (!launch) return json({ error: "launch or factory required" }, 400);
  return json({ rows: await listLedger(launch) });
}

export async function handleLedgerPost(req: Request): Promise<Response> {
  const body = (await req.json()) as Partial<TradeInput>;
  if (!body.launch || !body.trader || (body.side !== "buy" && body.side !== "sell")) {
    return json({ error: "launch, trader, side required" }, 400);
  }
  const row = await applyTrade({
    factory: body.factory ?? "",
    launch: body.launch,
    trader: body.trader,
    side: body.side,
    usdWad: String(body.usdWad ?? "0"),
    tokenWad: String(body.tokenWad ?? "0"),
    phase: body.phase,
    t: Number(body.t ?? Date.now()),
  });
  return json({ ok: true, row });
}

export async function handleRebalanceGet(req: Request): Promise<Response> {
  const launch = launchOf(new URL(req.url));
  if (!launch) return json({ error: "launch required" }, 400);
  return json({ events: await listRebalances(launch) });
}

export async function handleRebalancePost(req: Request): Promise<Response> {
  const body = (await req.json()) as {
    factory?: string;
    launch?: string;
    event?: RebalanceEvent;
  };
  if (!body.launch || !body.event) return json({ error: "launch and event required" }, 400);
  await insertRebalance(body.factory ?? "", body.launch, body.event);
  return json({ ok: true });
}

export async function handleXProfilesGet(_req: Request): Promise<Response> {
  return json({ profiles: await listXProfiles() });
}

/// The canonical wallet->X binding message. The wallet signs this EXACT text; the server refuses
/// any registry write whose signature does not recover to the posted address with the posted
/// username/id. Without this, anyone could bind any X identity to any wallet (or unlink one) and
/// contaminate every surface that renders identities.
export function xLinkMessage(address: string, username: string, xId: string): string {
  return `Levera X link\nwallet: ${address.toLowerCase()}\nusername: @${username}\nid: ${xId}`;
}

export function xUnlinkMessage(address: string): string {
  return `Levera X unlink\nwallet: ${address.toLowerCase()}`;
}

/// Recovers the signer from a personal_sign signature, or null when malformed.
function recoverSigner(message: string, signature: string): string | null {
  try {
    return ethers.verifyMessage(message, signature).toLowerCase();
  } catch {
    return null;
  }
}

export async function handleXProfilesPost(req: Request): Promise<Response> {
  const b = (await req.json()) as Record<string, unknown>;
  const rawAddress = typeof b.address === "string" ? b.address : "";
  const address = rawAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "invalid address" }, 400);
  const rawProfile = b.profile as Record<string, unknown> | undefined;
  if (!rawProfile || typeof rawProfile.username !== "string" || !rawProfile.username) {
    return json({ error: "invalid profile" }, 400);
  }
  const username = String(rawProfile.username).replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) return json({ error: "invalid username" }, 400);
  const xId = String(rawProfile.id ?? "");
  const signature = typeof b.signature === "string" ? b.signature : "";
  if (!signature) return json({ error: "signature required — prove you own this wallet to link it" }, 401);
  // The signature is over the POSTED username/id, so a valid signature for wallet W links W to
  // exactly the identity its owner signed — nothing else. No signature, no write.
  const signer = recoverSigner(xLinkMessage(address, username, xId), signature);
  if (signer !== address) {
    return json({ error: "signature does not prove ownership of this wallet" }, 401);
  }
  const profile: XProfile = {
    id: xId,
    name: String(rawProfile.name ?? ""),
    username,
    profileImageUrl: String(rawProfile.profileImageUrl ?? ""),
    connectedAt: typeof rawProfile.connectedAt === "number" ? rawProfile.connectedAt : Date.now(),
    updatedAt: Date.now(),
  };
  await upsertXProfile(address, profile);
  return json({ ok: true });
}

export async function handleXProfilesDelete(req: Request): Promise<Response> {
  const b = (await req.json()) as Record<string, unknown>;
  const rawAddress = typeof b.address === "string" ? b.address : "";
  const address = rawAddress.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return json({ error: "invalid address" }, 400);
  // Unlinking is also a write: an unsigned DELETE would let anyone strip a wallet's identity.
  const signature = typeof b.signature === "string" ? b.signature : "";
  if (!signature) return json({ error: "signature required — prove you own this wallet to unlink it" }, 401);
  const signer = recoverSigner(xUnlinkMessage(address), signature);
  if (signer !== address) {
    return json({ error: "signature does not prove ownership of this wallet" }, 401);
  }
  await deleteXProfile(address);
  return json({ ok: true });
}

export async function handleStoreDelete(req: Request): Promise<Response> {
  let factory = "";
  try {
    const b = (await req.json()) as { factory?: string };
    factory = (b.factory ?? "").trim();
  } catch {
    factory = factoryOf(new URL(req.url));
  }
  if (factory) await wipeFactory(factory);
  else await wipeAllSessionData();
  return json({ ok: true });
}

// ---- follows ---------------------------------------------------------------------------------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export async function handleFollowsGet(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = (url.searchParams.get("address") ?? "").trim();
  const viewer = (url.searchParams.get("viewer") ?? "").trim();
  if (!ADDRESS_RE.test(target)) return json({ error: "invalid address" }, 400);
  // ?list=followers|following swaps the counts for the wallets behind them -- the profile page's
  // follower/following modals read this. Public data, same as the counts themselves.
  const list = url.searchParams.get("list");
  if (list === "followers" || list === "following") {
    return json({ entries: await listFollows(target, list) });
  }
  const counts = await followCounts(target);
  const viewerFollows = ADDRESS_RE.test(viewer) ? await isFollowing(viewer, target) : false;
  return json({ ...counts, viewerFollows });
}

/// The DB side of a follow/unfollow. The route authenticates `follower` with a wallet signature
/// before calling this -- these functions deliberately trust their arguments, the way every other
/// handler here trusts its body.
export async function handleFollowsMutate(
  follower: string,
  target: string,
  action: "follow" | "unfollow",
): Promise<void> {
  if (action === "follow") await addFollow(follower, target, Date.now());
  else await removeFollow(follower, target);
}
