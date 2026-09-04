// Regenerates testnet/artifacts/*.abi.json from the local Forge build (contracts/out).
//
// These ABI-only files are COMMITTED so the keeper can run on a host that has never run
// `forge build` (e.g. the Render worker): `lib/chain.mjs`'s artifact() prefers the Forge output
// when it exists — full fidelity on the laptop — and falls back to this bundle when it does not.
// ABIs are public interface metadata; committing them leaks nothing. Re-run this after any
// contract change, before shipping a new keeper bundle:
//
//   cd contracts && forge build && cd ../testnet && node make-abi-bundle.mjs
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const outDir = path.join(repoRoot, "contracts", "out");
const destDir = path.join(here, "artifacts");

const NAMES = [
  "EarnPool",
  "Launch",
  "LaunchpadFactory",
  "MemePairFactory",
  "MockPriceOracle",
  "OracleSwapRouter",
  "MockWETH",
  "MockUSDG",
  "MockERC20",
  "QuoteZap",
  "ShockableOracle",
];

fs.mkdirSync(destDir, { recursive: true });
for (const name of NAMES) {
  const p = path.join(outDir, `${name}.sol`, `${name}.json`);
  const a = JSON.parse(await fs.promises.readFile(p, "utf8"));
  if (!a.abi?.length) throw new Error(`${name}: empty ABI`);
  await fs.promises.writeFile(
    path.join(destDir, `${name}.abi.json`),
    JSON.stringify(a.abi, null, 2) + "\n",
  );
  console.log(`bundled ${name} (${a.abi.length} entries)`);
}
