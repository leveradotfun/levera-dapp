import { handleHfycNavGet, handleHfycNavPost, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handleHfycNavGet);
export const POST = wrap(handleHfycNavPost);
