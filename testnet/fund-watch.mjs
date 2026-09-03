// Waits for the testnet deployer to be funded, then deploys and verifies automatically.
//
// Validates the key up front (`requireKey`) rather than letting `new ethers.Wallet(undefined)`
// throw an opaque error after the watch loop has already started, and requires an explicit
// `--yes` flag before doing an unattended deploy: this script silently redeploys and re-publishes
// data/deployment-testnet.json (which every user's frontend polls) the moment the balance clears,
// with no confirmation step -- fine when you just ran it on purpose, not something that should be
// left running by habit.
import { ethers } from "ethers";
import { execSync } from "child_process";
import { loadEnvFile, requireKey, TESTNET_RPC_URL } from "./lib/chain.mjs";

if (!process.argv.includes("--yes")) {
  console.error(
    "fund-watch.mjs deploys and overwrites data/deployment-testnet.json the moment the balance " +
      "clears, unattended. Re-run with --yes to confirm that's what you want.",
  );
  process.exit(1);
}

loadEnvFile();
const key = requireKey("DEPLOYER_PRIVATE_KEY");
const provider = new ethers.JsonRpcProvider(TESTNET_RPC_URL, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(key, provider);
const MIN = ethers.parseEther("0.002");

console.log(`Watching ${wallet.address} on testnet 46630 — will deploy at >= 0.002 ETH`);
for (let i = 0; ; i++) {
  try {
    const bal = await provider.getBalance(wallet.address);
    console.log(`[${new Date().toISOString()}] balance ${ethers.formatEther(bal)} ETH`);
    if (bal >= MIN) {
      console.log("Funded — deploying...");
      execSync("node deploy.mjs", { stdio: "inherit" });
      console.log("Deploy done — verifying...");
      execSync("node verify.mjs --probe-launch", { stdio: "inherit" });
      process.exit(0);
    }
  } catch (e) {
    console.log(`poll error: ${String(e?.message ?? e).slice(0, 80)}`);
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
