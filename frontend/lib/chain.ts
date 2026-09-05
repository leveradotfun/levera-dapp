// Local Anvil chain constants. This app is deliberately scoped to LOCAL testing only -- real
// testnet/mainnet deployment stays a manual `forge script` step (see contracts/script/
// DeployTestnet.s.sol), never something a browser page does with a real private key.

import { RPC_URL, TARGETING_TESTNET } from "./chains";

/// The RPC every ethers read/write in this app goes through. The local fork serves chain 4663 from
/// localhost; set NEXT_PUBLIC_RPC_URL=https://rpc.testnet.chain.robinhood.com to target testnet
/// instead (see testnet/README.md). One variable, one target — the wagmi transport and the shared
/// deployment file follow the same switch.
export const ANVIL_RPC_URL = RPC_URL;

// Anvil's standard default test accounts, derived from its fixed default mnemonic
// ("test test test test test test test test test test test junk"). These are publicly known,
// zero-value test keys -- the same on every machine that runs plain `anvil` with no extra flags.
// Never use these for anything real.
export const ANVIL_ACCOUNTS: { address: string; privateKey: string }[] = [
  { address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", privateKey: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" },
  { address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", privateKey: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" },
  { address: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", privateKey: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" },
  { address: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", privateKey: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6" },
  { address: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", privateKey: "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a" },
  { address: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc", privateKey: "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba" },
  { address: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", privateKey: "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e" },
  { address: "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955", privateKey: "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356" },
  { address: "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f", privateKey: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97" },
  { address: "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720", privateKey: "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6" },
];

// Account 0 is the shared admin/keeper key: /ui deploys, auto-graduates, and rebalances from it,
// and this app's own token faucet mints from it too (see mintUsdg/mintWeth in lib/launchpad.ts) --
// it should never be the one signing a person's own launches or trades.
export const DEPLOYER = ANVIL_ACCOUNTS[0];

// Identity for launches, trades, holdings, and fees is the wallet the person connects (see
// lib/activeSigner.ts and lib/wallet.ts). There is no built-in trading account.

// Deliberately the SAME storage key the /ui console uses: deploy the stack once from that console
// and this app picks up the exact same addresses, rather than each app maintaining its own idea of
// where the contracts live (and silently disagreeing after a redeploy).
// Suffixed per target so a browser tab that once loaded the fork deployment cannot feed fork
// addresses into a testnet-targeted app (or vice versa) — same origin, different chains.
export const DEPLOYED_ADDRESSES_KEY = TARGETING_TESTNET
  ? "launchpad-ui:deployed-addresses:testnet"
  : "launchpad-ui:deployed-addresses";

export type DeployedAddresses = {
  weth: string;
  usdg: string;
  /// The `ShockableOracle` every contract actually reads. On an untouched session this is the live
  /// feed passed straight through; the research console can move it to drive a collateral path.
  oracle: string;
  /// The underlying `ChainlinkPriceOracle`, kept so the console can show the real feed beside a
  /// shocked one and nobody has to wonder which number they are looking at.
  feed?: string;
  /// Deploys each graduating launch's AMM pair, so the pair's creation code lives here once
  /// instead of inside every Launch clone.
  pairFactory?: string;
  /// Wraps native ETH at the edge for WETH-quoted launches. `Launch` takes its quote asset as a
  /// plain ERC-20 and nothing else, which is what lets cbBTC be a quote asset at all.
  quoteZap?: string;
  /// One-transaction xTOKEN exits into any listed asset: sells on the launch, then routes
  /// quote -> USDG -> target across the earn registry's venues in the same tx. Optional because
  /// deployments that predate it fall back to the multi-transaction sell + swap path.
  xzap?: string;
  /// The second quote asset: 8 decimals, priced off Robinhood Chain's live CBBTC/USD feed. The
  /// token is a stand-in — the feed is real, the ERC-20 is not deployed on the chain yet.
  cbbtc?: string;
  cbbtcOracle?: string;
  cbbtcRouter?: string;
  /// The cbBTC-quoted launchpad. A creator picks their quote asset by picking the launchpad.
  cbbtcFactory?: string;
  router: string;
  lyc: string;
  factory: string;
  launch: string;
  // When this deployment was published (ms epoch). Optional because addresses saved before this
  // field existed won't have it -- treated as "oldest possible" by the shared-deployment sync, see
  // lib/deploymentSync.ts, so an old entry always loses to anything the shared file has.
  updatedAt?: number;
  /// The block this deployment was created in. Every `eth_getLogs` the app issues starts here
  /// rather than at 0: nothing these contracts emitted can predate their own deployment, and on a
  /// public chain 111M blocks deep a scan from genesis is the most expensive query on the page.
  /// Optional -- absent on the local fork and on files written before this field existed, which
  /// fall back to 0 (the previous behaviour).
  deployBlock?: number;
};

/// Older saves called the cash token `usdc`. Read either key so a stale localStorage entry
/// still points at the same address after the rename.
///
/// Every extra field is carried through, not just the ones this file defines: the multi-quote
/// deployment adds a second launchpad (`cbbtcFactory`) plus its oracle/router/token, and a
/// normalize that dropped them would make the create page offer one quote asset no matter how
/// many the deployment actually has.
export function normalizeDeployedAddresses(raw: unknown): DeployedAddresses | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const usdg = (typeof o.usdg === "string" && o.usdg) || (typeof o.usdc === "string" && o.usdc) || "";
  if (typeof o.factory !== "string" || !o.factory || !usdg) return null;
  // deploy.mjs still writes this field as "hfyc" (predates the LYC rename); read either key so an
  // already-published deployment file keeps resolving to the right EarnPool/LYC address.
  const lyc = (typeof o.lyc === "string" && o.lyc) || (typeof o.hfyc === "string" && o.hfyc) || "";
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : undefined);
  return {
    weth: String(o.weth ?? ""),
    usdg,
    oracle: String(o.oracle ?? ""),
    router: String(o.router ?? ""),
    lyc,
    factory: o.factory,
    launch: String(o.launch ?? ""),
    feed: str("feed"),
    pairFactory: str("pairFactory"),
    quoteZap: str("quoteZap"),
    xzap: str("xzap"),
    cbbtc: str("cbbtc"),
    cbbtcOracle: str("cbbtcOracle"),
    cbbtcRouter: str("cbbtcRouter"),
    cbbtcFactory: str("cbbtcFactory"),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : undefined,
    deployBlock: typeof o.deployBlock === "number" ? o.deployBlock : undefined,
  };
}

export function loadDeployedAddresses(): DeployedAddresses | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(DEPLOYED_ADDRESSES_KEY);
  if (!raw) return null;
  try {
    return normalizeDeployedAddresses(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveDeployedAddresses(addrs: DeployedAddresses) {
  window.localStorage.setItem(DEPLOYED_ADDRESSES_KEY, JSON.stringify(addrs));
}

export function clearDeployedAddresses() {
  window.localStorage.removeItem(DEPLOYED_ADDRESSES_KEY);
}

/// Drops this origin's copy of a deployment plus leftover local keys. On the local fork this also
/// wipes the Postgres session series (NAV, prices, ledgers) via `/api/store`, because a re-forked
/// Anvil reuses CREATE addresses and old rows would be attributed to coins that no longer exist.
///
/// On TESTNET it does not. Testnet contracts persist across page loads, browsers and redeploys, so
/// what is in Postgres is durable history rather than session state — and the trigger here is not
/// a deploy at all. `appState.tsx` calls this from a 3s poll whenever the shared deployment file
/// looks new to THIS browser, which includes the case where the browser has simply never seen it:
/// `loadDeployedAddresses()` returns null, `factory` is therefore undefined, and an undefined
/// factory sends `{}` — which `handleStoreDelete` reads as "no factory" and answers with
/// `wipeAllSessionData()`, a TRUNCATE of every session table. A first page load in a fresh profile,
/// a cleared site setting, or a private window would each erase the whole testnet series.
export function wipeFrontendDeploymentState(factory?: string) {
  if (typeof window === "undefined") return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (
        k === DEPLOYED_ADDRESSES_KEY ||
        k === "launchpad-price-history" ||
        k.startsWith("launchpad-frontend:ledger:") ||
        k.startsWith("lyc-nav:")
      ) {
        doomed.push(k);
      }
    }
    for (const k of doomed) window.localStorage.removeItem(k);
  } catch {
    // private mode
  }
  if (TARGETING_TESTNET) return;

  void fetch("/api/store", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(factory ? { factory } : {}),
  }).catch(() => {});
}
