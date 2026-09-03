import { ethers } from "ethers";
import { getAccount, getWalletClient, switchChain } from "wagmi/actions";
import { config } from "./wagmi";
import { getProvider, withSignerLock } from "./signers";
import { RPC_URL } from "./chains";

/// Who signs a user-initiated transaction: the wallet the person connected, and only that.
///
/// There is no built-in fallback key. Signing with a hidden burner while the header shows a
/// connected address would attribute launches, holdings, and fees to the wrong account.

export type ActiveSigner = {
  signer: ethers.Signer;
  address: string;
};

/// The address wagmi currently has authorised, if any. Reads the store rather than prompting —
/// `eth_requestAccounts` belongs in the connect modal, not in a balance poll.
export async function connectedAddress(): Promise<string | null> {
  const account = getAccount(config);
  return account.address ?? null;
}

export async function getActiveSigner(): Promise<ActiveSigner> {
  const account = getAccount(config);
  if (!account.address) {
    throw new Error("Connect a wallet to continue.");
  }

  // Writes go through the wallet, reads through the app RPC. If those disagree, the tx lands on
  // a chain this page is not even looking at. Switch first; a rejection is a real "no".
  const wanted = Number((await getProvider().getNetwork()).chainId);
  if (account.chainId !== wanted) {
    try {
      await switchChain(config, { chainId: wanted as 4663 | 46630 | 31337 });
    } catch {
      throw new Error("Switch your wallet to Robinhood Chain to continue.");
    }
  }

  const walletClient = await getWalletClient(config);
  if (!walletClient?.account) {
    throw new Error("Connect a wallet to continue.");
  }

  const { account: wcAccount, chain, transport } = walletClient;
  const network = {
    chainId: chain?.id ?? wanted,
    name: chain?.name ?? "Robinhood Chain",
  };
  const provider = new ethers.BrowserProvider(transport, network);
  const signer = await provider.getSigner(wcAccount.address);
  return { signer, address: wcAccount.address };
}

/// Serialises transactions per signing address so the UI cannot fire two approval prompts at
/// once — confusing, and easy to mis-click.
const WALLET_RPC_MISMATCH = `Your wallet is on the right chain but its RPC is not this app's node. In MetaMask, edit the network's RPC URL to ${RPC_URL}, then retry.`;

/// Refuse to send if the wallet's node has no code at `factory` — that is the silent "writes go
/// to public mainnet, reads come from the fork" failure, and ethers reports it as BAD_DATA /
/// missing revert data rather than anything a person can act on.
export async function assertWalletSeesApp(factoryAddress: string) {
  const sees = await walletSeesContracts(factoryAddress);
  if (sees === false) throw new Error(WALLET_RPC_MISMATCH);
}

export async function withActiveSigner<T>(fn: (active: ActiveSigner) => Promise<T>): Promise<T> {
  const active = await getActiveSigner();
  return withSignerLock(active.address, () => fn(active));
}

/// Whether the WALLET's node can see the app's contracts.
///
/// The local fork deliberately keeps mainnet's chain id (4663), which is what makes it a faithful
/// rehearsal — and also the one way this setup can go quietly wrong. MetaMask keys networks by
/// chain id, so if it already has a "Robinhood Chain" entry pointing at the public RPC, asking it
/// to add the fork does NOT replace that entry: it just switches to the one already there. The
/// chain id then matches, the app looks connected, and every read comes from localhost while every
/// write goes to real mainnet, where none of these contracts exist.
///
/// Comparing chain ids cannot detect that, because both are 4663. Asking the wallet's own node
/// whether the factory has code can, and costs one call.
export async function walletSeesContracts(factoryAddress: string): Promise<boolean | null> {
  if (!factoryAddress) return null;
  try {
    const walletClient = await getWalletClient(config);
    if (!walletClient) return null;
    // Asked through the WALLET's transport, deliberately -- the app's own provider would answer
    // from the node we already know about and always say yes. `eth_getCode` is outside viem's
    // wallet-method union (a wallet client is not meant to be a read client), which is exactly why
    // it has to be requested loosely rather than through a typed helper.
    const request = walletClient.request as unknown as (args: {
      method: string;
      params: unknown[];
    }) => Promise<unknown>;
    const code = (await request({
      method: "eth_getCode",
      params: [factoryAddress, "latest"],
    })) as string;
    return typeof code === "string" && code !== "0x" && code.length > 2;
  } catch {
    return null; // wallet unreachable -- say nothing rather than cry wolf
  }
}

/// The read provider. Reads always go through the app's own RPC rather than the wallet's, so a
/// wallet pointed at the wrong network cannot silently blank the page.
export { getProvider };
