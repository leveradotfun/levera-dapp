import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { saveArweaveBlob } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Launched-token images are pinned to IPFS via Pinata. Configure PINATA_JWT (a Pinata API JWT
// from the Pinata console) and optionally PINATA_GATEWAY (a dedicated gateway like
// https://<name>.mypinata.cloud) — until then uploads fall back to the Postgres-backed blob
// store so coin creation keeps working, and the response says `pinned: false`.
//
// The URL stored in token metadata is always the SAME-ORIGIN gateway (`/api/ipfs/<cid>`): public
// IPFS gateways rate-limit and the browser must never depend on one for rendering. The cid and
// provider url ride along in the response for anything that wants the permanent reference.

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);

const PINATA_PIN_URL = "https://api.pinata.cloud/pinning/pinFileToIPFS";

/// Tolerates a gateway host set without its scheme ("name.mypinata.cloud") — everything after a
/// restart reads the same value, so the default is applied here rather than policing the env.
function gatewayBase(): string {
  const raw = process.env.PINATA_GATEWAY?.replace(/\/+$/, "") ?? "https://ipfs.io";
  return raw.startsWith("http") ? raw : `https://${raw}`;
}

function ipfsGatewayUrl(cid: string): string {
  return `${gatewayBase()}/ipfs/${cid}`;
}

/// Same-origin serving path for a pinned cid or a fallback blob id.
function gatewayPath(id: string): string {
  return `/api/ipfs/${id}`;
}

async function pinToPinata(buffer: Buffer, contentType: string, fileName: string): Promise<string> {
  const jwt = process.env.PINATA_JWT!;
  const fd = new FormData();
  fd.append(
    "pinataMetadata",
    JSON.stringify({ name: fileName || `levera-token-${Date.now()}`, keyvalues: { app: "levera" } }),
  );
  fd.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  fd.append("file", new Blob([new Uint8Array(buffer)], { type: contentType }), fileName || "image");
  const res = await fetch(PINATA_PIN_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Pinata ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { IpfsHash?: string };
  if (!json.IpfsHash) throw new Error("Pinata returned no IpfsHash");
  return json.IpfsHash;
}

export async function POST(req: Request) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return NextResponse.json({ error: "No file provided. Send as multipart/form-data with field 'file'." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "File too large. Max 5MB." }, { status: 400 });
    }
    if (file.type && !file.type.startsWith("image/")) {
      return NextResponse.json({ error: `Unsupported type ${file.type}. Use png, jpg, webp, gif or svg.` }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = file.type || "image/png";
    // Content-addressed fallback id — identical bytes always land on the same id, so repeat
    // uploads of the same image are deduped by the blob store's ON CONFLICT DO NOTHING.
    const fallbackId = createHash("sha256").update(buffer).digest("hex");

    if (process.env.PINATA_JWT) {
      try {
        const cid = await pinToPinata(buffer, contentType, file.name);
        // Cache locally too: the gateway route serves repeat renders from Postgres instead of
        // hammering the public gateway on every page view.
        await saveArweaveBlob(`ipfs-${cid}`, buffer, contentType).catch(() => {});
        return NextResponse.json({
          cid,
          provider: "pinata",
          url: ipfsGatewayUrl(cid),
          gatewayUrl: gatewayPath(cid),
          contentType,
          size: buffer.length,
          pinned: true,
        });
      } catch (e) {
        // Pinata outage/quotas must not block a coin launch — fall through to the local store,
        // with the reason surfaced so the operator knows pinning did not happen.
        const reason = e instanceof Error ? e.message : String(e);
        await saveArweaveBlob(`ipfs-${fallbackId}`, buffer, contentType);
        return NextResponse.json({
          cid: fallbackId,
          provider: "local",
          url: gatewayPath(`ipfs-${fallbackId}`),
          gatewayUrl: gatewayPath(`ipfs-${fallbackId}`),
          contentType,
          size: buffer.length,
          pinned: false,
          message: `Pinata pin failed (${reason.slice(0, 140)}) — stored locally, not pinned.`,
        });
      }
    }

    await saveArweaveBlob(`ipfs-${fallbackId}`, buffer, contentType);
    return NextResponse.json({
      cid: fallbackId,
      provider: "local",
      url: gatewayPath(`ipfs-${fallbackId}`),
      gatewayUrl: gatewayPath(`ipfs-${fallbackId}`),
      contentType,
      size: buffer.length,
      pinned: false,
      message: "PINATA_JWT not configured — stored locally only, not pinned to IPFS.",
    });
  } catch (e) {
    console.error("ipfs upload failed", e);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
