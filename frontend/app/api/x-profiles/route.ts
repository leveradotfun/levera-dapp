import { handleXProfilesDelete, handleXProfilesGet, handleXProfilesPost, wrap } from "@/db/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = wrap(handleXProfilesGet);
export const POST = wrap(handleXProfilesPost);
export const DELETE = wrap(handleXProfilesDelete);
