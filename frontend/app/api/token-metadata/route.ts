import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { getTokenMetadata, listTokenMetadata, upsertTokenMetadata } from "@/db/store";
import { normMetadataField, tokenMetadataMessage } from "@/lib/metadataSigning";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isValidUrl(s: string | null | undefined): boolean {
  if (!s) return true; // optional
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const launch = searchParams.get("launch");
  const launches = searchParams.get("launches"); // comma-separated
  if (launch) {
    const meta = await getTokenMetadata(launch);
    return NextResponse.json({ metadata: meta });
  }
  if (launches) {
    const list = launches.split(",").map((s) => s.trim()).filter(Boolean);
    const map = await listTokenMetadata(list);
    return NextResponse.json({ metadatas: map });
  }
  return NextResponse.json({ error: "Provide ?launch=0x... or ?launches=0x...,0x..." }, { status: 400 });
}

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/// The launch's on-chain creator — the only wallet allowed to write its metadata. Read fresh per
/// request: nothing in Postgres records creators, and the chain is the source of truth anyway.
async function creatorOf(launch: string): Promise<string | null> {
  try {
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
    const launch_ = new ethers.Contract(
      launch,
      ["function creator() view returns (address)"],
      provider,
    );
    return ((await launch_.creator()) as string).toLowerCase();
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const launch = String(body.launch ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(launch)) {
      return NextResponse.json({ error: "Invalid launch address" }, { status: 400 });
    }
    // Normalize FIRST (identical to what gets stored), then require the creator's signature over
    // exactly these values. Without the signature, anyone could rewrite any coin's image or
    // description; with it, only the wallet that launched the coin can.
    const meta = {
      imageUrl: normMetadataField(body.imageUrl),
      website: normMetadataField(body.website),
      telegram: normMetadataField(body.telegram),
      discord: normMetadataField(body.discord),
      twitter: normMetadataField(body.twitter),
      description: normMetadataField(body.description),
    };
    const signature = typeof body.signature === "string" ? body.signature : "";
    if (!signature) {
      return NextResponse.json(
        { error: "signature required — only the launch's creator can save its metadata" },
        { status: 401 },
      );
    }
    const creator = await creatorOf(launch);
    if (!creator) {
      return NextResponse.json({ error: "Could not read the launch's creator from the chain" }, { status: 503 });
    }
    const signer = ethers.verifyMessage(tokenMetadataMessage(launch, meta), signature).toLowerCase();
    if (signer !== creator) {
      return NextResponse.json(
        { error: "signature does not belong to this launch's creator" },
        { status: 403 },
      );
    }
    const { imageUrl, website, telegram, discord, twitter, description } = meta;

    if (website && !isValidUrl(website)) return NextResponse.json({ error: "Website must be a valid https:// URL" }, { status: 400 });
    if (telegram && !isValidUrl(telegram) && !telegram.startsWith("@") && !telegram.startsWith("https://t.me/")) {
      // allow @handle or t.me link
      if (!/^@?[a-zA-Z0-9_]{3,32}$/.test(telegram.replace("https://t.me/", "").replace("@", ""))) {
        // still allow, just warn — don't block
      }
    }
    if (discord && !isValidUrl(discord)) return NextResponse.json({ error: "Discord must be a valid https:// URL" }, { status: 400 });
    if (
      imageUrl &&
      !isValidUrl(imageUrl) &&
      !imageUrl.startsWith("/api/arweave/") &&
      !imageUrl.startsWith("/api/ipfs/") &&
      !imageUrl.startsWith("https://arweave.net/") &&
      !/^ipfs:\/\//.test(imageUrl)
    ) {
      return NextResponse.json({ error: "imageUrl must be an https:// URL, an IPFS gateway/cid path, or an arweave URL" }, { status: 400 });
    }
    if (imageUrl && imageUrl.length > 500) return NextResponse.json({ error: "imageUrl too long" }, { status: 400 });
    if (website && website.length > 300) return NextResponse.json({ error: "website too long" }, { status: 400 });
    if (description && description.length > 500) return NextResponse.json({ error: "description too long (max 500 chars)" }, { status: 400 });

    await upsertTokenMetadata({
      launch,
      imageUrl,
      website,
      telegram,
      discord,
      twitter,
      description,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("token-metadata POST failed", e);
    return NextResponse.json({ error: "Failed to save metadata" }, { status: 500 });
  }
}
