// One tick of protocol housekeeping against the live testnet deployment: harvest fees,
// auto-graduate sold-out curves, attach idle LYC to 2x coins with a gap, fill open rebalance
// routes back into band, and settle Earn Pool occupancy accrual.
//
// WHY THIS EXISTS
// ----------------
// ui/lib/keeper.ts's useKeeper hook does all of this already -- but only while someone has the
// admin console open in a browser tab (its own comment says so: "Runs for as long as this page
// is open"), and its provider (ui/lib/signers.ts's getProvider()) is hardcoded to the local Anvil
// fork with no testnet branch at all. So on testnet, that keeper silently does nothing no matter
// which tab is open. This script is the persistent, browser-independent replacement -- and the
// shape a real keeper needs to take for mainnet too: a standalone process, not a page. Run it from
// cron/launchd the same way refresh-prices.mjs is (see the LaunchAgent set up alongside it).
//
//   cd testnet && node keeper.mjs
//
// Reads DEPLOYER_PRIVATE_KEY from .env -- the same key used everywhere else in this harness. That
// key holds MINTER_ROLE on every mock token from construction (FaucetMintable grants it to
// msg.sender), which is what lets fillSellRoute/fillBuyRoute below mint whatever USDG/WETH they
// need to fill a route, exactly like ui/lib/launch.ts's fillSellRoute/fillBuyRoute already do on
// Anvil -- that pattern is safe to port here unchanged, not an Anvil-only shortcut.
import { ethers } from "ethers";
import {
  DEPLOYED_TESTNET_PATH,
  artifact,
  testnetProvider,
  requireChain,
  requireKey,
  loadEnvFile,
  sendTx,
} from "./lib/chain.mjs";
import { readFileSync } from "node:fs";

loadEnvFile();

const WAD = 10n ** 18n;
const MAX_BAND_STEPS = 6;

const LaunchAbi = artifact("Launch").abi;
const FactoryAbi = artifact("LaunchpadFactory").abi;
const EarnPoolAbi = artifact("EarnPool").abi;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function fetchLaunchAddresses(factory) {
  const count = await factory.launchCount();
  const out = [];
  for (let i = 0n; i < count; i++) out.push(await factory.allLaunches(i));
  return out;
}

async function ensureBalance(token, holder, needed, signer, label) {
  const bal = await token.balanceOf(holder);
  if (bal < needed) {
    await sendTx(`mint ${label} for route fill`, () => token.connect(signer).mint(holder, needed - bal));
  }
}

async function fillSellRouteIfOpen(launch, deployment, signer, holder, label) {
  for (let i = 0; i < MAX_BAND_STEPS; i++) {
    const [available, priceWad] = await launch.sellRouteQuote();
    if (available === 0n || priceWad === 0n) break;
    const usdgIn = (available * priceWad) / WAD + 1n;
    const usdg = new ethers.Contract(deployment.usdg, ERC20_ABI, signer);
    await ensureBalance(usdg, holder, usdgIn, signer, "USDG");
    await sendTx(`${label} approve USDG for fillSellRoute`, () => usdg.approve(launch.target, usdgIn));
    const levBefore = await launch.leverageWad();
    await sendTx(`${label} fillSellRoute`, () => launch.fillSellRoute(usdgIn, 0n));
    const levAfter = await launch.leverageWad();
    log(`${label}: filled sell route, leverage ${Number(levBefore) / 1e18} -> ${Number(levAfter) / 1e18}`);
    if (Number(levAfter) / 1e18 < 2.2) break;
  }
}

async function fillBuyRouteIfOpen(launch, deployment, signer, holder, label) {
  for (let i = 0; i < MAX_BAND_STEPS; i++) {
    const [wanted] = await launch.buyRouteQuote();
    if (wanted === 0n) break;
    const weth = new ethers.Contract(deployment.weth, ERC20_ABI, signer);
    await ensureBalance(weth, holder, wanted, signer, "WETH");
    await sendTx(`${label} approve WETH for fillBuyRoute`, () => weth.approve(launch.target, wanted));
    const levBefore = await launch.leverageWad();
    await sendTx(`${label} fillBuyRoute`, () => launch.fillBuyRoute(wanted, 0n));
    const levAfter = await launch.leverageWad();
    log(`${label}: filled buy route, leverage ${Number(levBefore) / 1e18} -> ${Number(levAfter) / 1e18}`);
    if (Number(levAfter) / 1e18 > 1.8) break;
  }
}

async function tickOne(launchAddress, deployment, signer, holder) {
  const label = launchAddress.slice(0, 8);
  const launch = new ethers.Contract(launchAddress, LaunchAbi, signer);
  try {
    try {
      await sendTx(`${label} harvest`, () => launch.harvest());
    } catch {
      // no booked fees this tick -- expected most ticks, not worth logging
    }

    const graduated = await launch.graduated();
    if (!graduated) {
      const [realEthRaised, targetRaiseEth] = await Promise.all([
        launch.realEthRaised(),
        launch.targetRaiseEth(),
      ]);
      if (realEthRaised >= targetRaiseEth) {
        log(`${label}: raise met -- auto-graduating...`);
        await sendTx(`${label} graduate`, () => launch.graduate());
        log(`${label}: graduated.`);
      }
      return;
    }

    const [paired, leverageEnabled, leverageWad] = await Promise.all([
      launch.paired(),
      launch.leverageEnabled(),
      launch.leverageWad(),
    ]);
    const lev = Number(leverageWad) / 1e18;

    if (leverageEnabled) {
      const gap = await launch.seniorGapUsd();
      if (gap > 0n) {
        const earn = new ethers.Contract(deployment.lyc, EarnPoolAbi, signer);
        const idle = await earn.idleUsdg();
        if (idle > 0n) {
          try {
            const slice = idle / 8n > 0n ? idle / 8n : idle;
            await sendTx(`${label} tryPairUpTo`, () => launch.tryPairUpTo(slice));
            log(`${label}: attached idle LYC toward 2x.`);
          } catch (e) {
            const m = e?.shortMessage || e?.message || String(e);
            if (!/not pairable|leverage off/i.test(m)) log(`${label}: tryPairUpTo failed: ${m.slice(0, 120)}`);
          }
        }
      }
    }

    // Rebalancing is filled by whoever wants the trade, not executed by the protocol -- see
    // Launch.sol's own comment on the route mechanism. This keeper plays that counterparty so
    // routes don't sit open indefinitely on a quiet testnet with no real arbitrageurs watching;
    // on mainnet this is meant to be a backstop, not the primary filler (see the "Routes" page
    // idea discussed alongside this script).
    if (paired && lev >= 2.2) {
      log(`${label}: leverage ${lev.toFixed(2)}x -- sell route open, filling...`);
      await fillSellRouteIfOpen(launch, deployment, signer, holder, label);
    } else if (paired && lev > 0 && lev <= 1.8) {
      log(`${label}: leverage ${lev.toFixed(2)}x -- buy route open, filling...`);
      await fillBuyRouteIfOpen(launch, deployment, signer, holder, label);
    }

    // The AMM quotes off junior ETH but can only pay from the reserve. On a rally part of the
    // vault stops backing senior and starts belonging to junior, while still sitting where a
    // seller cannot reach it -- a bucket correction, not a trade.
    try {
      const cover = await launch.reserveCoverWad();
      if (cover < WAD) await sendTx(`${label} rebalanceToReserve`, () => launch.rebalanceToReserve());
    } catch {
      // nothing to move, or no excess above the claim
    }
  } catch (e) {
    const msg = e?.shortMessage || e?.message || String(e);
    if (!/already graduated|position healthy|no loop equity|no rebalance needed|revert/i.test(msg)) {
      log(`${label}: keeper error: ${msg.slice(0, 150)}`);
    }
  }
}

async function main() {
  const key = requireKey("DEPLOYER_PRIVATE_KEY");
  const provider = testnetProvider();
  await requireChain(provider);
  const signer = new ethers.NonceManager(new ethers.Wallet(key, provider));
  const holder = await signer.getAddress();

  const deployment = JSON.parse(readFileSync(DEPLOYED_TESTNET_PATH, "utf8"));
  if (!deployment.lyc) throw new Error("deployment-testnet.json has no `lyc` field -- redeploy or check the file.");

  const factoryAddresses = [deployment.factory, deployment.cbbtcFactory].filter(Boolean);
  const launchAddresses = (
    await Promise.all(
      factoryAddresses.map((f) => fetchLaunchAddresses(new ethers.Contract(f, FactoryAbi, provider))),
    )
  ).flat();

  log(`Keeper tick: ${launchAddresses.length} launch(es) across ${factoryAddresses.length} factory(ies).`);

  if (launchAddresses.length > 0) {
    try {
      const earn = new ethers.Contract(deployment.lyc, EarnPoolAbi, signer);
      await sendTx("accruePools", () => earn.accruePools(launchAddresses.slice(0, 32)));
    } catch (e) {
      const msg = e?.shortMessage || e?.message || String(e);
      log(`accruePools failed: ${msg.slice(0, 150)}`);
    }
  }

  // Sequential, not parallel: every action here signs with the same deployer key, and concurrent
  // sends from one key is exactly the nonce-race class this harness has hit before (see
  // ui/lib/signers.ts's withSignerLock and its own comment on the same problem).
  for (const addr of launchAddresses) {
    await tickOne(addr, deployment, signer, holder);
  }

  log("Keeper tick done.");
}

main().catch((e) => {
  console.error("Keeper tick failed:", e?.message || e);
  process.exitCode = 1;
});
