// Real feed prices for the mock oracles.
//
// Testnet (46630) has no Chainlink feeds of its own — every mainnet feed address is empty code
// there — but the PRICES are still knowable: the deploy reads the real Robinhood mainnet
// aggregators over plain eth_call, the same feeds the local fork reads, and seeds MockPriceOracle
// with them. Nothing on testnet is therefore priced off a made-up constant; it is priced off a
// snapshot of the real market, taken at deploy time, and re-taken by refresh-prices.mjs.
//
// A pin (TESTNET_ETH_USD / TESTNET_USDG_USD / TESTNET_CBBTC_USD) always wins over the live read,
// so a deterministic rerun or an offline deploy stays possible. ETH and cbBTC fail closed — no
// price, no deploy — because a wrong collateral price poisons every valuation on the chain.
// USDG falls back to $1.00 with a warning, matching the app's own behaviour when the cash feed
// is unreadable.
//
// CHANGES IN THIS FILE, AND WHY
// ------------------------------
// The original `readFeedWad` destructured only `answer` from `latestRoundData()`:
//
//     const [, answer] = await withRetry(..., () => agg.latestRoundData());
//
// `updatedAt`, `roundId` and `answeredInRound` were read and discarded. A mainnet aggregator that
// stalled days ago still returns a positive `answer`, so a frozen price was read, printed as
// "(live mainnet feed)", and seeded into a mock oracle that stamps its OWN `publishedAt` at
// `block.timestamp` — laundering an arbitrarily old price into one the chain's own 25-hour
// staleness guard can never catch. The whole stated point of this file, "priced off a snapshot of
// the real market", failed silently instead of loudly. `readFeedWad` now enforces the same
// staleness bound the deployed `OracleLib` enforces, rejects an incomplete round, and rejects a
// magnitude outside sanity bounds (catches an address or decimals mistake before it reaches chain).
// The USDG par fallback is now an explicit opt-in (`ALLOW_USDG_PAR_FALLBACK=1`) rather than a
// silent default, because assuming par is exactly what the cash feed exists to avoid.
import { ethers } from "ethers";
import { MAINNET_FEEDS, mainnetProvider, withRetry } from "./chain.mjs";

const WAD = 10n ** 18n;

/// Mirrors OracleLib.MAX_PRICE_AGE on-chain (25h, matching Robinhood's 24h Chainlink heartbeat
/// plus slack). Seeding a price the chain itself would already reject as stale defeats the point.
const MAX_FEED_AGE_SECONDS = 25n * 60n * 60n;

/// Sanity rails that only reject nonsense (wrong address, decimals mismatch), not a market opinion.
const MIN_WAD = 10n ** 6n; // $0.000000000001
const MAX_WAD = 10n ** 30n; // $1e12

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

function scaleToWad(answer, decimals) {
  if (decimals === 18) return answer;
  if (decimals < 18) return answer * 10n ** BigInt(18 - decimals);
  return answer / 10n ** BigInt(decimals - 18);
}

async function readFeedWad(provider, feedAddress, label) {
  const code = await withRetry(`${label} code`, () => provider.getCode(feedAddress));
  if (code === "0x") throw new Error(`${label}: no contract at ${feedAddress}`);

  const agg = new ethers.Contract(feedAddress, AGGREGATOR_ABI, provider);
  const round = await withRetry(`${label} latestRoundData`, () => agg.latestRoundData());
  const decimals = Number(await withRetry(`${label} decimals`, () => agg.decimals()));

  const roundId = BigInt(round[0]);
  const answer = BigInt(round[1]);
  const updatedAt = BigInt(round[3]);
  const answeredInRound = BigInt(round[4]);

  if (answer <= 0n) throw new Error(`${label}: non-positive answer (${answer})`);
  if (updatedAt === 0n) throw new Error(`${label}: incomplete round (updatedAt == 0)`);
  if (answeredInRound < roundId) {
    throw new Error(`${label}: stale round (answeredInRound ${answeredInRound} < roundId ${roundId})`);
  }

  const block = await withRetry(`${label} block`, () => provider.getBlock("latest"));
  const now = BigInt(block.timestamp);
  const age = now > updatedAt ? now - updatedAt : 0n;
  if (age > MAX_FEED_AGE_SECONDS) {
    throw new Error(
      `${label}: feed is stale — last update ${age}s ago (limit ${MAX_FEED_AGE_SECONDS}s). ` +
        "Refusing to seed a price the chain itself would reject.",
    );
  }

  const wad = scaleToWad(answer, decimals);
  if (wad < MIN_WAD || wad > MAX_WAD) {
    throw new Error(`${label}: price ${ethers.formatUnits(wad, 18)} is outside sanity bounds (decimals mismatch?)`);
  }
  return { wad, ageSeconds: age };
}

function pin(name) {
  const raw = process.env[name];
  if (!raw) return null;
  const wad = ethers.parseUnits(raw.trim(), 18);
  if (wad < MIN_WAD || wad > MAX_WAD) throw new Error(`${name} is outside sanity bounds`);
  return wad;
}

function fmt(wad) {
  return `$${ethers.formatUnits(wad, 18)}`;
}

/// Live-seeded WAD prices: { ethUsd, usdgUsd, cbbtcUsd, sources }.
export async function fetchPrices({ log = console.log } = {}) {
  const provider = mainnetProvider();
  const sources = {};

  const ethPin = pin("TESTNET_ETH_USD");
  const usdgPin = pin("TESTNET_USDG_USD");
  const btcPin = pin("TESTNET_CBBTC_USD");

  let ethUsd;
  if (ethPin) {
    ethUsd = ethPin;
    sources.ethUsd = "pinned";
  } else {
    const r = await readFeedWad(provider, MAINNET_FEEDS.ethUsd, "ETH/USD");
    ethUsd = r.wad;
    sources.ethUsd = `live (${r.ageSeconds}s old)`;
  }
  log(`ETH/USD   ${fmt(ethUsd)}  (${sources.ethUsd})`);

  let usdgUsd;
  if (usdgPin) {
    usdgUsd = usdgPin;
    sources.usdgUsd = "pinned";
  } else {
    try {
      const r = await readFeedWad(provider, MAINNET_FEEDS.usdgUsd, "USDG/USD");
      usdgUsd = r.wad;
      sources.usdgUsd = `live (${r.ageSeconds}s old)`;
    } catch (e) {
      // Assuming par is exactly what the cash feed exists to avoid seeding blindly. Require an
      // explicit opt-in rather than doing it silently by default.
      if (process.env.ALLOW_USDG_PAR_FALLBACK !== "1") {
        throw new Error(
          `USDG/USD unreadable (${String(e?.message ?? e).slice(0, 90)}). ` +
            "Set TESTNET_USDG_USD to pin it, or ALLOW_USDG_PAR_FALLBACK=1 to knowingly accept " +
            "$1.00 and seed a chain that cannot represent a depeg.",
        );
      }
      usdgUsd = WAD;
      sources.usdgUsd = "PAR FALLBACK (feed unread — depeg not representable)";
      log("WARNING: seeding USDG at par; a depeg will be invisible on this chain.");
    }
  }
  log(`USDG/USD  ${fmt(usdgUsd)}  (${sources.usdgUsd})`);

  let cbbtcUsd;
  if (btcPin) {
    cbbtcUsd = btcPin;
    sources.cbbtcUsd = "pinned";
  } else {
    const r = await readFeedWad(provider, MAINNET_FEEDS.cbbtcUsd, "CBBTC/USD");
    cbbtcUsd = r.wad;
    sources.cbbtcUsd = `live (${r.ageSeconds}s old)`;
  }
  log(`CBBTC/USD ${fmt(cbbtcUsd)}  (${sources.cbbtcUsd})`);

  return { ethUsd, usdgUsd, cbbtcUsd, sources };
}
