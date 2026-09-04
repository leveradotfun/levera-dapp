/// Older records called the cash token `usdc` and the Earn Pool `hfyc` (both predate renames).
/// Read either key so a stale file keeps resolving to the same contracts.
/// The published deployment record — the same JSON `testnet/deploy.mjs` writes to
/// `data/deployment-testnet.json` (and the fork writes to `data/deployment.json`). The SDK reads
/// the record rather than hardcoding addresses, so a redeploy is a file swap, not a code change.
export type Deployment = {
  network?: string;
  chainId?: number;
  rpcUrl?: string;
  explorer?: string;
  /// Block the stack was deployed in. Reads that walk events should start here, not at 0.
  deployBlock?: number;
  updatedAt?: number;

  weth: string;
  usdg: string;
  /// The Earn Pool (LYC shares). This deployment's default collateral oracle.
  oracle: string;
  /// The WETH-quoted launchpad's swap router.
  router: string;
  lyc: string;
  /// The WETH-quoted launchpad factory.
  factory: string;
  /// The Launch implementation. Empty on the testnet record — clones are deployed fresh and the
  /// implementation address is readable off any clone, so nothing here requires it.
  launch?: string;

  feed?: string;
  pairFactory?: string;
  /// Wraps native ETH at the edge for WETH-quoted launches. Optional: a deployment without it
  /// cannot serve native-ETH buys/sells.
  quoteZap?: string;

  /// The second quote asset and its launchpad, when the deployment is multi-collateral.
  cbbtc?: string;
  cbbtcOracle?: string;
  cbbtcRouter?: string;
  cbbtcFactory?: string;

  /// Mock-oracle addresses on testnet (needed by the price refresher). Alias of `oracle`/`cbbtcOracle`.
  oracleEth?: string;
  oracleCbbtc?: string;
};

/// Older records called the cash token `usdc` and the Earn Pool `hfyc` (both predate renames).
/// Read either key so a stale file keeps resolving to the same contracts.
export function normalizeDeployment(raw: unknown): Deployment {
  if (!raw || typeof raw !== "object") {
    throw new Error("deployment record is not an object");
  }
  const o = raw as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : undefined);
  const num = (k: string): number | undefined => (typeof o[k] === "number" ? (o[k] as number) : undefined);

  const usdg = str("usdg") ?? str("usdc");
  const lyc = str("lyc") ?? str("hfyc");
  const factory = str("factory");
  const weth = str("weth");
  const oracle = str("oracle");
  const router = str("router");

  for (const [name, v] of Object.entries({ usdg, lyc, factory, weth, oracle, router })) {
    if (!v) throw new Error(`deployment record is missing "${name}" — not a Levera deployment file?`);
  }

  return {
    network: str("network"),
    chainId: num("chainId"),
    rpcUrl: str("rpcUrl"),
    explorer: str("explorer"),
    deployBlock: num("deployBlock"),
    updatedAt: num("updatedAt"),
    weth: weth!,
    usdg: usdg!,
    oracle: oracle!,
    router: router!,
    lyc: lyc!,
    factory: factory!,
    launch: str("launch"),
    feed: str("feed"),
    pairFactory: str("pairFactory"),
    quoteZap: str("quoteZap"),
    cbbtc: str("cbbtc"),
    cbbtcOracle: str("cbbtcOracle"),
    cbbtcRouter: str("cbbtcRouter"),
    cbbtcFactory: str("cbbtcFactory"),
    oracleEth: str("oracleEth") ?? oracle,
    oracleCbbtc: str("oracleCbbtc") ?? str("cbbtcOracle"),
  };
}

/// One launchpad = one quote asset. A creator picks their quote asset by picking the launchpad,
/// and a coin is bound to its pad's factory, oracle and router for life.
export type QuoteLaunchpad = {
  /// "weth" or "cbbtc" for the two standard pads; custom pads get their token address as the id.
  id: string;
  factory: string;
  collateralToken: string;
  oracle: string;
  router: string;
};

/// The launchpads this deployment carries, in a stable order (WETH first).
export function launchpadsOf(d: Deployment): QuoteLaunchpad[] {
  const pads: QuoteLaunchpad[] = [
    { id: "weth", factory: d.factory, collateralToken: d.weth, oracle: d.oracle, router: d.router },
  ];
  if (d.cbbtcFactory) {
    pads.push({
      id: "cbbtc",
      factory: d.cbbtcFactory,
      collateralToken: d.cbbtc!,
      oracle: d.cbbtcOracle!,
      router: d.cbbtcRouter!,
    });
  }
  return pads;
}
