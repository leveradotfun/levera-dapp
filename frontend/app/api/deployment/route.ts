import { promises as fs } from "fs";
import path from "path";

// Reads the deployment the local console wrote (see ui/app/api/deployment/route.ts) or the
// testnet harness published (testnet/deploy.mjs). Shared through a file at the repo root because
// browser localStorage is per-origin and these two apps run on different ports, so they cannot see
// each other's saved addresses directly.
//
// ?chain=testnet reads data/deployment-testnet.json instead — a browser pointed at the testnet
// RPC must not pick up the local fork's addresses just because both files happen to exist.
const SHARED_PATH = path.join(process.cwd(), "..", "data", "deployment.json");
const TESTNET_PATH = path.join(process.cwd(), "..", "data", "deployment-testnet.json");

export async function GET(request: Request) {
  const chain = new URL(request.url).searchParams.get("chain");
  const file = chain === "testnet" ? TESTNET_PATH : SHARED_PATH;
  try {
    const raw = await fs.readFile(file, "utf8");
    return Response.json(JSON.parse(raw));
  } catch {
    return Response.json({ error: "no deployment recorded yet" }, { status: 404 });
  }
}
