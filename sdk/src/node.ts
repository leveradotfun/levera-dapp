/// Node-only entry: `@levera/sdk/node`. Browser bundles should never import this — it exists so
/// a Node script can point the SDK straight at `data/deployment-testnet.json`.
import { readFileSync } from "node:fs";
import { normalizeDeployment, type Deployment } from "./deployment.js";

/// Load a deployment record from disk, accepting the file exactly as `deploy.mjs` publishes it.
export function loadDeploymentFile(path: string): Deployment {
  return normalizeDeployment(JSON.parse(readFileSync(path, "utf8")));
}
