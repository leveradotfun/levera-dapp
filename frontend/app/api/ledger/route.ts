import { handleLedgerGet, handleLedgerPost, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handleLedgerGet);
export const POST = wrap(handleLedgerPost);
