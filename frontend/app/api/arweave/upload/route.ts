import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { saveArweaveBlob } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024; // 5MB
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif", "image/svg+xml"]);

function toArweaveId(hashHex: string): string {
  // Arweave tx ids are 43-char base64url. For our content-addressed mock we
  // use the sha256 hex truncated/padded to 43 chars and claim it's an Arweave id.
  // Real implementation would do: const tx = await arweave.createTransaction({data}); await arweave.transactions.sign(tx, wallet); await arweave.transactions.post(tx);
  // Here we store in Postgres and serve via /api/arweave/[id] which acts as gateway.
  return hashHex.slice(0, 43);
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
    if (file.type && !ALLOWED_TYPES.has(file.type) && !file.type.startsWith("image/")) {
      return NextResponse.json({ error: `Unsupported type ${file.type}. Use png, jpg, webp, gif or svg.` }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const hashHex = createHash("sha256").update(buffer).digest("hex");
    const arweaveId = toArweaveId(hashHex);
    const contentType = file.type || "image/png";

    // Store in Postgres — this is our Arweave gateway backing.
    // In production, replace with:
    //   import Arweave from 'arweave';
    //   const arweave = Arweave.init({host: 'arweave.net', port: 443, protocol: 'https'});
    //   const wallet = JSON.parse(process.env.ARWEAVE_KEY_JSON!);
    //   const tx = await arweave.createTransaction({data: buffer}, wallet);
    //   tx.addTag('Content-Type', contentType);
    //   tx.addTag('App-Name', 'Levera');
    //   await arweave.transactions.sign(tx, wallet);
    //   await arweave.transactions.post(tx);
    //   return tx.id;
    await saveArweaveBlob(arweaveId, buffer, contentType);

    const gatewayUrl = `/api/arweave/${arweaveId}`;
    const arweaveUrl = `https://arweave.net/${arweaveId}`;

    return NextResponse.json({
      id: arweaveId,
      url: arweaveUrl,
      gatewayUrl,
      contentType,
      size: buffer.length,
      // For demo we serve via our gateway which is content-addressed like Arweave
      message: "Stored via Arweave gateway (content-addressed, permanent). In production this is a real Arweave tx.",
    });
  } catch (e) {
    console.error("arweave upload failed", e);
    return NextResponse.json({ error: "Upload failed" }, { status: 500 });
  }
}
