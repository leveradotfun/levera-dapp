import { http, createConfig } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";
import { foundry } from "wagmi/chains";
import { robinhood, robinhoodTestnet, RPC_URL, TARGETING_TESTNET, PUBLIC_MAINNET_RPC, TESTNET_RPC } from "./chains";

/// Get a project ID at https://cloud.reown.com (free) and set it as
/// NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID in .env.local. Without one, WalletConnect is simply left
/// out of the connector list -- the rest of the app (injected/extension wallets) is unaffected --
/// rather than the app throwing at startup over a missing credential nobody has set up yet.
const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;

const connectors = [
  injected({ shimDisconnect: true }),
  ...(WALLETCONNECT_PROJECT_ID
    ? [
        walletConnect({
          projectId: WALLETCONNECT_PROJECT_ID,
          showQrModal: true,
          metadata: {
            name: "Levera",
            description: "Launch and trade tokens on Robinhood Chain",
            url: typeof window !== "undefined" ? window.location.origin : "https://levera.fun",
            icons: ["/logo.svg"],
          },
        }),
      ]
    : []),
];

/// Only the chains this app can actually be used on. The previous config also listed mainnet,
/// sepolia, polygon, arbitrum and base, which meant a wallet could "connect" successfully to a
/// network where none of these contracts exist and every read would fail with no explanation.
export const config = createConfig({
  chains: [robinhood, robinhoodTestnet, foundry],
  connectors,
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
