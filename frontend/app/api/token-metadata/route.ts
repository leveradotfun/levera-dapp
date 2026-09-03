import { NextResponse } from "next/server";
import { getTokenMetadata, listTokenMetadata, upsertTokenMetadata } from "@/db/store";

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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const launch = String(body.launch ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(launch)) {
      return NextResponse.json({ error: "Invalid launch address" }, { status: 400 });
    }
    const imageUrl = body.imageUrl != null ? String(body.imageUrl).trim() : null;
    const website = body.website != null ? String(body.website).trim() : null;
    const telegram = body.telegram != null ? String(body.telegram).trim() : null;
    const discord = body.discord != null ? String(body.discord).trim() : null;
    const twitter = body.twitter != null ? String(body.twitter).trim() : null;
    const description = body.description != null ? String(body.description).trim() : null;

    if (website && !isValidUrl(website)) return NextResponse.json({ error: "Website must be a valid https:// URL" }, { status: 400 });
    if (telegram && !isValidUrl(telegram) && !telegram.startsWith("@") && !telegram.startsWith("https://t.me/")) {
      // allow @handle or t.me link
      if (!/^@?[a-zA-Z0-9_]{3,32}$/.test(telegram.replace("https://t.me/", "").replace("@", ""))) {
        // still allow, just warn — don't block
      }
    }
    if (discord && !isValidUrl(discord)) return NextResponse.json({ error: "Discord must be a valid https:// URL" }, { status: 400 });
    if (imageUrl && !isValidUrl(imageUrl) && !imageUrl.startsWith("/api/arweave/") && !imageUrl.startsWith("https://arweave.net/")) {
      return NextResponse.json({ error: "imageUrl must be an https:// or arweave URL" }, { status: 400 });
    }
    if (imageUrl && imageUrl.length > 500) return NextResponse.json({ error: "imageUrl too long" }, { status: 400 });
    if (website && website.length > 300) return NextResponse.json({ error: "website too long" }, { status: 400 });

    await upsertTokenMetadata({
      launch,
      imageUrl: imageUrl || null,
      website: website || null,
      telegram: telegram || null,
      discord: discord || null,
      twitter: twitter || null,
      description: description || null,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("token-metadata POST failed", e);
    return NextResponse.json({ error: "Failed to save metadata" }, { status: 500 });
  }
}
