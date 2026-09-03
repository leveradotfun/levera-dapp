// Deploy-time gate on bytecode integrity. Thin wrapper around contracts/hash-artifacts.mjs --
// that file is the single source of truth for the hashing logic and the lock file format (see
// its own header comment for the full reasoning); this just shells out to it and turns a nonzero
// exit code into a clear error deploy.mjs can throw before deploying anything.
//
// Why a subprocess rather than importing it directly: contracts/ and testnet/ are deliberately
// independent git repositories (see testnet/README.md's "Bytecode integrity" section) that do
// not intertwine. They remain sibling directories on the same local filesystem for anyone
// actually running a deploy, so calling into contracts/hash-artifacts.mjs as a plain child
// process works today without either repo depending on the other's module graph, npm workspace,
// or package name -- the only coupling is "this file exists at this relative path," which is
// already true of `contracts/out/` itself (lib/chain.mjs's `artifact()` reads it the same way).
import { spawnSync } from "child_process";
import path from "path";
import crypto from "crypto";
import { repoRoot } from "./chain.mjs";

const HASH_SCRIPT = path.join(repoRoot, "contracts", "hash-artifacts.mjs");

/// Same formula as contracts/hash-artifacts.mjs's own hashBytecode -- duplicated because it's a
/// pure four-line function with no state and no lock-file opinions of its own; deploy.mjs uses
/// it only to RECORD which hash each contract deployed with, never to decide whether to deploy
/// (that decision is `requireApprovedArtifacts` below, which always defers to the real script).
export function hashBytecode(bytecode) {
  const hex = typeof bytecode === "string" ? bytecode : bytecode?.object;
  if (typeof hex !== "string") throw new Error("hashBytecode: expected a hex string or a {object} artifact field");
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return "sha256:" + crypto.createHash("sha256").update(Buffer.from(clean, "hex")).digest("hex");
}

/// Structured diff of contracts/out/ against contracts/artifacts.lock.json -- see
/// contracts/hash-artifacts.mjs's own `diffAgainstLock` for the shape. Never throws; callers
/// decide how to react (deploy.mjs refuses to deploy on any problem, verify.mjs reports and
/// keeps checking everything else).
export function diffAgainstLock() {
  const result = spawnSync(process.execPath, [HASH_SCRIPT, "check", "--json"], { encoding: "utf8" });
  if (result.error || !result.stdout) {
    // Can't even run the script -- report it the same shape a real diff would have, so callers
    // don't need a separate error path.
    return { ok: false, lockExists: false, missing: [], mismatched: [], matched: [], current: {}, error: result.error?.message ?? result.stderr };
  }
  return JSON.parse(result.stdout);
}

/// Throws with a clear, actionable message unless every pinned contract's current bytecode
/// matches the committed lock file in contracts/artifacts.lock.json. Call this from deploy.mjs
/// before deploying anything.
export function requireApprovedArtifacts() {
  const diff = diffAgainstLock();
  if (diff.ok) return diff;

  const lines = [];
  if (diff.error) lines.push(`Could not run ${HASH_SCRIPT}: ${diff.error}`);
  if (!diff.lockExists) {
    lines.push(
      `No lock file at contracts/artifacts.lock.json. Run \`node contracts/hash-artifacts.mjs write\` ` +
        "after reviewing contracts/src, then commit it before deploying.",
    );
  } else {
    if (diff.missing.length) lines.push(`Not pinned in the lock file: ${diff.missing.join(", ")}.`);
    if (diff.mismatched.length) {
      lines.push(
        "Bytecode does not match the committed lock file for: " +
          diff.mismatched.map((m) => m.name).join(", ") +
          ". Either contracts/src changed without re-approving the lock file, or contracts/out/ " +
          "is stale/corrupt. Re-run `forge build`; if the change is intentional and reviewed, " +
          "regenerate with `node contracts/hash-artifacts.mjs write` and commit the result.",
      );
    }
  }
  throw new Error("Refusing to deploy unapproved bytecode:\n  " + lines.join("\n  "));
}
