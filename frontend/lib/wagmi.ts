import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { foundry } from "wagmi/chains";
import { robinhood, robinhoodTestnet, RPC_URL, TARGETING_TESTNET, PUBLIC_MAINNET_RPC, TESTNET_RPC } from "./chains";

/// Only the chains this app can actually be used on. The previous config also listed mainnet,
/// sepolia, polygon, arbitrum and base, which meant a wallet could "connect" successfully to a
/// network where none of these contracts exist and every read would fail with no explanation.
export const config = createConfig({
  chains: [robinhood, robinhoodTestnet, foundry],
  connectors: [injected({ shimDisconnect: true })],
  ssr: true,
  transports: {
    // The transport for the chain the app TARGETS follows NEXT_PUBLIC_RPC_URL, so the wallet and
    // the app never end up talking to two different nodes that both claim to be that chain. The
    // other chain gets its honest public endpoint: pointing 4663's transport at the testnet RPC
    // (or the reverse) would put the wallet on a chain where these contracts do not exist, and
    // every read would come back empty with nothing on screen explaining why. On the local fork,
    // 4663 and 8545 are the same chain, which is why the fork default routes 4663 to RPC_URL.
    [robinhood.id]: http(TARGETING_TESTNET ? PUBLIC_MAINNET_RPC : RPC_URL),
    [robinhoodTestnet.id]: http(TARGETING_TESTNET ? RPC_URL : TESTNET_RPC),
    [foundry.id]: http("http://127.0.0.1:8545"),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
