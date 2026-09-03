import { handleStoreDelete, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const DELETE = wrap(handleStoreDelete);
