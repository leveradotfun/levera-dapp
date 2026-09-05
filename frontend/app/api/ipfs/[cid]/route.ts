import { NextResponse } from "next/server";
import { getArweaveBlob, saveArweaveBlob } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Same-origin IPFS gateway for launched-token images. Two kinds of ids arrive here:
//   - real IPFS CIDs (Qm… v0 / baf… v1) — fetched from the configured gateway and cached in
//     Postgres, so repeat renders never depend on a public gateway being up or fast;
//   - `ipfs-<sha256>` fallback ids written by the upload route when Pinata is unconfigured —
//     served straight from Postgres.
// The arweave_blobs table is the generic content-blob store behind both gateways.

const IPFS_CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{4,58})$/;
const FALLBACK_ID_RE = /^ipfs-[a-f0-9]{64}$/;

function ipfsSourceUrl(cid: string): string {
  const raw = process.env.PINATA_GATEWAY?.replace(/\/+$/, "") ?? "https://ipfs.io";
  const base = raw.startsWith("http") ? raw : `https://${raw}`;
  return `${base}/ipfs/${cid}`;
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ cid: string }> }
) {
  const { cid } = await params;
  if (!cid || (!IPFS_CID_RE.test(cid) && !FALLBACK_ID_RE.test(cid))) {
    return NextResponse.json({ error: "Invalid cid" }, { status: 400 });
  }

  const storeKey = IPFS_CID_RE.test(cid) ? `ipfs-${cid}` : cid;
  const cached = await getArweaveBlob(storeKey).catch(() => null);
  if (cached) {
    return new NextResponse(cached.data as unknown as BodyInit, {
      headers: {
        "Content-Type": cached.contentType,
        // Content-addressed: the bytes for an id never change, so cache forever.
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }

  // Real CIDs not in the cache: fetch once, cache, serve.
  if (IPFS_CID_RE.test(cid)) {
    try {
      const upstream = await fetch(ipfsSourceUrl(cid), { signal: AbortSignal.timeout(20_000) });
      if (!upstream.ok || !upstream.body) {
        return NextResponse.json({ error: `Upstream gateway ${upstream.status}` }, { status: 502 });
      }
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const contentType = upstream.headers.get("content-type")?.split(";")[0] || "application/octet-stream";
      if (!contentType.startsWith("image/") && !contentType.startsWith("application/octet-stream")) {
        return NextResponse.json({ error: `Upstream returned ${contentType}, not an image` }, { status: 502 });
      }
      await saveArweaveBlob(storeKey, buffer, contentType).catch(() => {});
      return new NextResponse(buffer as unknown as BodyInit, {
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } catch (e) {
      return NextResponse.json(
        { error: `IPFS fetch failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 502 },
      );
    }
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
