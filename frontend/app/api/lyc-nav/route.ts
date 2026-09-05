import { handleLycNavGet, handleLycNavPost, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handleLycNavGet);
export const POST = wrap(handleLycNavPost);
