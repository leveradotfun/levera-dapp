import { ethers } from "ethers";
import { DeployedAddresses } from "./chain";
import { getProvider } from "./signers";

/// The quote assets a coin can be launched and traded in.
///
/// The quote asset IS the collateral: a coin is denominated in it, pairs against it, and — if it is
/// 2x — is levered against it. A launchpad factory is bound to one at construction, so choosing a
/// quote asset is choosing a launchpad, and it is immutable for that coin afterwards.
///
/// Nothing here assumes 18 decimals. cbBTC is 8, and every amount a user types has to be parsed in
/// the asset's own units — `parseUnits(x, 18)` on a cbBTC amount is 1e10 too large, which is the
/// difference between a half-cbBTC raise and a 5-billion one.

export type QuoteAsset = {
  /// The launchpad that mints coins quoted in this asset.
  factory: string;
  token: string;
  symbol: string;
  /// What this asset reads as to a person: "ETH" for the wrapped-native quote (nobody depositing
  /// native through the QuoteZap thinks of it as "WETH"), the token's own symbol otherwise.
  label: string;
  decimals: number;
  /// The headline raise, in the asset's own units.
  targetRaise: bigint;
  /// What that raise reads as to a human.
  targetRaiseLabel: string;
  /// Native ETH can be wrapped into this asset at the edge by `QuoteZap`. Only true for WETH.
  wrapsNativeEth: boolean;
  /// Max share of TOTAL_SUPPLY (1e9) a creator may take in the dev buy bundled into creation, in
  /// bps. Read live off the factory rather than assumed, since it is an owner-settable parameter
  /// (LaunchpadFactory.setCreatorBuyCapBps) -- a hardcoded 20% here would silently go stale the
  /// same way the trading-fee constants elsewhere in this app already have once.
  creatorBuyCapBps: bigint;
};

const ERC20 = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const FACTORY = [
  "function collateralToken() view returns (address)",
  "function minRaise() view returns (uint256)",
  "function creatorBuyCapBps() view returns (uint256)",
];

/// Headline raises, per asset, in whole tokens. Different numbers because they are different
/// assets: 6.9 ETH (~$16k) and 0.2 cbBTC (~$15k) are same-order headlines. The cbBTC floor is
/// NOT arbitrary: the factory's minRaise is a tenth of a whole token (0.1 cbBTC), so the branded
/// 0.069 default would revert "raise too small" on every cbBTC launch — hence 0.2.
///
/// Keyed by symbol, with one deliberate exception: the ETH headline is keyed off wrapping native
/// gas, not the symbol string, because the mock token on a fresh deployment is called "mWETH" —
/// keying on the symbol silently dropped every ETH raise to the fallback.
const TARGET_RAISE: Record<string, string> = {
  ETH: "6.9",
  cbBTC: "0.2",
};
const FALLBACK_RAISE = "1";

async function describe(factory: string, wethAddress: string): Promise<QuoteAsset | null> {
  try {
    const f = new ethers.Contract(factory, FACTORY, getProvider());
    const token: string = await f.collateralToken();
    const t = new ethers.Contract(token, ERC20, getProvider());
    const [symbol, decimalsRaw, creatorBuyCapBps] = await Promise.all([
      t.symbol() as Promise<string>,
      t.decimals() as Promise<bigint>,
      f.creatorBuyCapBps() as Promise<bigint>,
    ]);
    const decimals = Number(decimalsRaw);
    const wrapsNativeEth = token.toLowerCase() === wethAddress.toLowerCase();
    const whole = wrapsNativeEth ? TARGET_RAISE.ETH : (TARGET_RAISE[symbol] ?? FALLBACK_RAISE);
    return {
      factory,
      token,
      symbol,
      label: wrapsNativeEth ? "ETH" : symbol,
      decimals,
      targetRaise: ethers.parseUnits(whole, decimals),
      targetRaiseLabel: whole,
      wrapsNativeEth,
      creatorBuyCapBps,
    };
  } catch {
    // A launchpad that cannot be described is one that is not deployed here. Leaving it out is
    // better than offering a choice that reverts.
    return null;
  }
}

/// Every launchpad this deployment has, newest last. Always at least the WETH one.
export async function listQuoteAssets(addresses: DeployedAddresses): Promise<QuoteAsset[]> {
  const candidates = [addresses.factory, addresses.cbbtcFactory].filter(Boolean) as string[];
  const described = await Promise.all(candidates.map((f) => describe(f, addresses.weth)));
  return described.filter((q): q is QuoteAsset => q !== null);
}

/// The quote asset a given launch trades in, read off the launch itself.
export async function quoteAssetOf(launchAddress: string): Promise<{ token: string; symbol: string; decimals: number }> {
  const l = new ethers.Contract(launchAddress, ["function quote() view returns (address)"], getProvider());
  const token: string = await l.quote();
  const t = new ethers.Contract(token, ERC20, getProvider());
  return { token, symbol: await t.symbol(), decimals: Number(await t.decimals()) };
}

/// Parse a human amount into a quote asset's own units. Never assume 18.
export function parseQuote(amount: string, decimals: number): bigint {
  return ethers.parseUnits(amount || "0", decimals);
}

export function formatQuote(amount: bigint, decimals: number, places = 4): string {
  const s = ethers.formatUnits(amount, decimals);
  const [whole, frac = ""] = s.split(".");
  return places > 0 ? `${whole}.${frac.padEnd(places, "0").slice(0, places)}` : whole;
}
