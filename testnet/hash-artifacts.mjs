// Convenience passthrough to contracts/hash-artifacts.mjs, which is the canonical script (see
// its own header comment). This exists only so `npm run hash-artifacts:check` works from
// testnet/, where anyone doing deploy work is already sitting -- contracts/ and testnet/ are
// deliberately independent git repos, so the real logic lives in exactly one of them, not both.
//
//   node hash-artifacts.mjs check   node hash-artifacts.mjs write
import { spawnSync } from "child_process";
import path from "path";
import { repoRoot } from "./lib/chain.mjs";

const target = path.join(repoRoot, "contracts", "hash-artifacts.mjs");
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(result.status ?? 1);
