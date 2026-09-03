import { defineChain } from "viem";

/// Robinhood Chain, as it actually is. The values here were previously guessed — chain id 101,
/// `rpc.robinhood.com`, `explorer.robinhood.com` — and none of them exist. A wrong chain id is
/// worse than a missing one: it makes a wallet sign transactions for a network that isn't there.
///
/// Verified against the live RPC:
///   eth_chainId -> 0x1237 (4663) mainnet, 0xb626 (46630) testnet.
export const ROBINHOOD_MAINNET_ID = 4663;
export const ROBINHOOD_TESTNET_ID = 46630;
export const LOCAL_ANVIL_ID = 31337;

/// Chains a connected wallet is allowed to transact on from this app. Anything else needs a
/// switch — writes go through the wallet, so a MetaMask left on Ethereum would otherwise send
/// the launch/trade somewhere this page is not even reading.
export function isAppChain(chainId: number | undefined | null): boolean {
  return chainId === ROBINHOOD_MAINNET_ID || chainId === ROBINHOOD_TESTNET_ID;
}

/// The RPC this app — and any wallet it asks to add the network — should talk to.
///
/// This matters more than it looks. When MetaMask is asked to switch to chain 4663 it may add the
/// network using THIS url, and it is the url the wallet then sends transactions to. Point it at
/// the public endpoint while developing against a local fork and the wallet connects successfully
/// to a chain where none of these contracts exist: reads come back empty and writes revert, with
/// nothing on screen explaining why.
///
/// So it defaults to the local fork, which is where the contracts actually are during development.
/// Set NEXT_PUBLIC_RPC_URL to point the whole app somewhere else — e.g. the testnet RPC once
/// `testnet/deploy.mjs` has run. This one variable is the app's target: the ethers provider, the
/// wallet's transport, and which shared deployment file is read all follow it.
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
export const PUBLIC_MAINNET_RPC = "https://rpc.mainnet.chain.robinhood.com";
export const TESTNET_RPC = "https://rpc.testnet.chain.robinhood.com";

/// What this build of the app talks to. Derived from the RPC rather than a second env var so the
/// provider, the wallet transport, and the deployment source cannot disagree: pointing
/// NEXT_PUBLIC_RPC_URL at the testnet endpoint IS switching the app to testnet.
export const TARGETING_TESTNET = RPC_URL.includes("testnet");

export const robinhood = defineChain({
  id: ROBINHOOD_MAINNET_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://robinhoodchain.blockscout.com" },
  },
});

export const robinhoodTestnet = defineChain({
  id: ROBINHOOD_TESTNET_ID,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: { name: "Blockscout", url: "https://explorer.testnet.chain.robinhood.com" },
  },
  testnet: true,
});

/// Where a transaction hash should link. Falls back to the mainnet explorer, since the local fork
/// shares mainnet's id — a locally-mined hash won't resolve there, which is honest: it genuinely
/// does not exist on the public chain.
export function explorerTxUrl(chainId: number, hash: string): string {
  const base =
    chainId === ROBINHOOD_TESTNET_ID
      ? robinhoodTestnet.blockExplorers.default.url
      : robinhood.blockExplorers.default.url;
  return `${base}/tx/${hash}`;
}

export function explorerAddressUrl(chainId: number, address: string): string {
  const base =
    chainId === ROBINHOOD_TESTNET_ID
      ? robinhoodTestnet.blockExplorers.default.url
      : robinhood.blockExplorers.default.url;
  return `${base}/address/${address}`;
}
