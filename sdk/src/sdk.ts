import { JsonRpcProvider, type ContractRunner, type Provider, type Signer } from "ethers";
import { launchpadsOf, normalizeDeployment, type Deployment, type QuoteLaunchpad } from "./deployment.js";
import { Erc20, faucetMint } from "./erc20.js";
import { OracleReader } from "./oracle.js";
import { EarnPool } from "./earnPool.js";
import { Launch } from "./launch.js";
import { Launchpad } from "./launchpad.js";
import { QuoteZap, SwapRouter } from "./periphery.js";

export type LeveraSDKOptions = {
  /// A deployment record — the JSON `testnet/deploy.mjs` publishes. Unknown extra fields are
  /// fine; anything the SDK needs that is missing throws at construction.
  deployment: unknown;
  /// RPC endpoint. Optional when `provider` is given; falls back to the record's own `rpcUrl`.
  rpcUrl?: string;
  /// Bring your own provider (wagmi transport, browser-injected, IndexedDB-backed…).
  provider?: Provider;
  /// Optional signer for writes. Reads never need one. Also settable via `sdk.connect(signer)`.
  signer?: Signer;
};

export type SdkCaches = {
  /// Immutable launch facts, per lowercase address, per SDK instance. Addresses are reused
  /// across deployments (a re-forked chain replays the same CREATE sequence), so the cache
  /// lives on the instance rather than the module — a new deployment must not inherit the old
  /// one's quote asset or scale.
  launchMeta: Map<string, import("./launch.js").LaunchMeta>;
};

/// Entry point for the Levera stack: two launchpads, their coins, the Earn Pool behind them,
/// the native-ETH zap and the oracle-priced routers.
///
/// ```ts
/// const sdk = new LeveraSDK({ rpcUrl, deployment });
/// for (const coin of await sdk.allLaunchSummaries()) console.log(coin.symbol, coin.marketCapUsd);
///
/// const wallet = sdk.connect(signer);
/// await wallet.launch(coin).buy({ amountIn: parseUnits("0.1", 18) });
/// ```
export class LeveraSDK {
  readonly deployment: Deployment;
  readonly provider: Provider;
  readonly launchpads: QuoteLaunchpad[];
  readonly caches: SdkCaches = { launchMeta: new Map() };
  private _signer: Signer | null;

  constructor(opts: LeveraSDKOptions) {
    this.deployment = normalizeDeployment(opts.deployment);
    if (opts.provider) {
      this.provider = opts.provider;
    } else {
      const rpcUrl = opts.rpcUrl ?? this.deployment.rpcUrl;
      if (!rpcUrl) throw new Error("no rpcUrl given and the deployment record has none");
      // staticNetwork: the deployment record pins the chain; don't burn a round trip proving it.
      this.provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
    }
    this._signer = opts.signer ?? null;
    this.launchpads = launchpadsOf(this.deployment);
  }

  /// Same deployment and provider, writing through `signer` instead. Returns a NEW instance —
  /// the original stays read-only, and per-instance caches stay with their deployment.
  connect(signer: Signer): LeveraSDK {
    return new LeveraSDK({ deployment: this.deployment, provider: this.provider, signer });
  }

  get signer(): Signer | null {
    return this._signer;
  }

  /// Signer when connected, provider otherwise — the runner reads always work through.
  get runner(): ContractRunner {
    return this._signer ?? this.provider;
  }

  // ---- contract handles ----

  /// A launchpad by id: "weth" or "cbbtc" for the two standard pads, or a factory address.
  launchpad(id: string = "weth"): Launchpad {
    const idLower = id.toLowerCase();
    const pad = this.launchpads.find(
      (p) => p.id === idLower || p.factory.toLowerCase() === idLower
    );
    if (!pad) {
      throw new Error(`no launchpad "${id}" in this deployment — has: ${this.launchpads.map((p) => p.id).join(", ")}`);
    }
    return new Launchpad(this, pad);
  }

  launch(address: string): Launch {
    return new Launch(this, address);
  }

  earnPool(): EarnPool {
    return new EarnPool(this);
  }

  /// The native-ETH zap. Throws when the deployment record has none — the SDK will not silently
  /// route native ETH through a path that does not exist.
  zap(): QuoteZap {
    if (!this.deployment.quoteZap) {
      throw new Error("this deployment has no quoteZap — native-ETH buys/sells are unavailable");
    }
    return new QuoteZap(this);
  }

  /// The oracle-priced router for a pad's quote asset ("weth" | "cbbtc" | token address).
  router(padId: string = "weth"): SwapRouter {
    const pad = this.resolvePad(padId);
    const address = pad.router;
    if (!address) throw new Error(`pad "${pad.id}" has no router in this deployment`);
    return new SwapRouter(this, address, pad.collateralToken);
  }

  /// The price oracle for a pad's quote asset, or an explicit oracle address.
  oracle(padIdOrAddress: string = "weth"): OracleReader {
    const pad = this.launchpads.find((p) => p.id === padIdOrAddress.toLowerCase());
    const address = pad ? pad.oracle : padIdOrAddress;
    return new OracleReader(address, this.provider);
  }

  token(address: string): Erc20 {
    return new Erc20(address, this.runner);
  }

  weth(): Erc20 {
    return this.token(this.deployment.weth);
  }

  usdg(): Erc20 {
    return this.token(this.deployment.usdg);
  }

  /// The second quote asset. Throws when the deployment is single-collateral.
  cbbtc(): Erc20 {
    if (!this.deployment.cbbtc) throw new Error("this deployment has no cbBTC pad");
    return this.token(this.deployment.cbbtc);
  }

  private resolvePad(padId: string): QuoteLaunchpad {
    const idLower = padId.toLowerCase();
    const pad = this.launchpads.find((p) => p.id === idLower || p.collateralToken.toLowerCase() === idLower);
    if (!pad) {
      throw new Error(`no quote asset "${padId}" in this deployment — has: ${this.launchpads.map((p) => p.id).join(", ")}`);
    }
    return pad;
  }

  // ---- cross-pad conveniences ----

  /// Every launchpad this deployment carries. Coins live on the factory that minted them, so
  /// anything enumerating "all launches" must ask both pads — listing only the WETH factory
  /// makes every cbBTC coin invisible.
  async allLaunchAddresses(): Promise<string[]> {
    const lists = await Promise.all(
      this.launchpads.map((p) => new Launchpad(this, p).launchAddresses())
    );
    return lists.flat();
  }

  async allLaunchSummaries() {
    const addresses = await this.allLaunchAddresses();
    const summaries = await Promise.all(
      addresses.map((a) => this.launch(a).summary().catch(() => null))
    );
    return summaries.filter((s): s is NonNullable<typeof s> => s !== null);
  }

  async launchSummariesByCreator(creator: string) {
    const creatorLower = creator.toLowerCase();
    const lists = await Promise.all(
      this.launchpads.map((p) => new Launchpad(this, p).launchesByCreator(creator))
    );
    return Promise.all(
      lists.flat().filter((a) => a.toLowerCase() !== "").map((a) => this.launch(a).summary())
    ).then((all) => all.filter((s) => s.meta.creator.toLowerCase() === creatorLower));
  }

  // ---- testnet faucet (mock tokens only; meaningless off a test chain) ----

  mintUsdg(to: string, amount: bigint) {
    return faucetMint(this.deployment.usdg, to, amount, this.runner);
  }

  mintWeth(to: string, amount: bigint) {
    return faucetMint(this.deployment.weth, to, amount, this.runner);
  }

  mintCbbtc(to: string, amountBaseUnits: bigint) {
    if (!this.deployment.cbbtc) throw new Error("this deployment has no cbBTC pad");
    return faucetMint(this.deployment.cbbtc, to, amountBaseUnits, this.runner);
  }
}
