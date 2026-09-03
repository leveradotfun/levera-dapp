import { NextResponse } from "next/server";
import { getArweaveBlob } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id || !/^[a-f0-9]{43}$|^[a-f0-9]{64}$|^[A-Za-z0-9_-]{43}$/.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  const blob = await getArweaveBlob(id);
  if (!blob) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return new NextResponse(blob.data as unknown as BodyInit, {
    headers: {
      "Content-Type": blob.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      // Arweave gateway headers
      "X-Arweave-Id": id,
    },
  });
}
