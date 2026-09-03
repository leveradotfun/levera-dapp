import { handleRebalanceGet, handleRebalancePost, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handleRebalanceGet);
export const POST = wrap(handleRebalancePost);
