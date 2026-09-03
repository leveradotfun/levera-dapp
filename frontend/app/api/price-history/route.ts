import { handlePriceGet, handlePricePost, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handlePriceGet);
export const POST = wrap(handlePricePost);
