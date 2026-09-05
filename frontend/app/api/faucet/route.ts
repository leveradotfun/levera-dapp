import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { getFaucetClaim, recordFaucetClaim } from "@/db/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The daily community faucet. Mock tokens mint from the faucet key (the mocks' mint is public —
// that is what makes them mocks), and ETH comes out of a COMMUNITY POT: a wallet other users
// contribute their excess ETH to, so someone out of gas can still claim 0.001/day. Limits are
// enforced per address per UTC day in Postgres — off-chain, which is honest for a testnet
// faucet and needs no protocol change.

type Asset = "cbbtc" | "weth" | "usdg" | "eth";

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";
const TARGETING_TESTNET = RPC_URL.includes("testnet");

const SHARED_DIR = path.join(process.cwd(), "..", "data");

function deploymentRecord(): Record<string, string> {
  const file = TARGETING_TESTNET ? "deployment-testnet.json" : "deployment.json";
  try {
    return JSON.parse(fs.readFileSync(path.join(SHARED_DIR, file), "utf8"));
  } catch {
    return {};
  }
}

function testnetEnv(key: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), "..", "testnet", ".env"), "utf8");
    const m = raw.match(new RegExp(`^${key}=(.+)$`, "m"));
    return m?.[1]?.trim();
  } catch {
    return undefined;
  }
}

// The key that pays: on testnet the COMMUNITY POT wallet (contributions land there); on the
// local fork the shared admin account, which is funded by Anvil. Never returned to the client.
//
// SECURITY: this used to fall back to `DEPLOYER_PRIVATE_KEY` when no faucet key was configured --
// privilege escalation by omission. The faucet is the most publicly-exposed signer in the stack
// (anyone with a wallet signature can trigger it); the deployer key owns the Earn Pool, both
// factories and both oracles. A misconfigured faucet must fail closed, never silently reach for
// the most powerful key in the deployment. Configure `FAUCET_PRIVATE_KEY` explicitly; there is no
// other path. It needs MINTER_ROLE on each token it mints (see FaucetMintable.sol) -- grant it at
// deploy time, not by handing it ownership of anything.
function faucetWallet(provider: ethers.JsonRpcProvider): ethers.Wallet {
  if (!TARGETING_TESTNET) {
    // Anvil's deterministic account 0 — publicly known, zero-value test key, fork-only.
    return new ethers.Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
  }
  const key = process.env.FAUCET_PRIVATE_KEY ?? testnetEnv("FAUCET_PRIVATE_KEY");
  if (!key) {
    throw new Error(
      "No FAUCET_PRIVATE_KEY configured (testnet/.env). The faucet will not fall back to the " +
        "deployer key -- set a dedicated faucet key with MINTER_ROLE on the token contracts.",
    );
  }
  return new ethers.Wallet(key, provider);
}

const ASSETS: Record<Asset, { label: string; decimals: number; daily: string; amount: bigint; tokenOf: (dep: Record<string, string>) => string | undefined }> = {
  cbbtc: { label: "cbBTC", decimals: 8, daily: "1", amount: ethers.parseUnits("1", 8), tokenOf: (d) => d.cbbtc },
  weth: { label: "WETH", decimals: 18, daily: "50", amount: ethers.parseUnits("50", 18), tokenOf: (d) => d.weth },
  usdg: { label: "USDG", decimals: 18, daily: "100,000", amount: ethers.parseUnits("100000", 18), tokenOf: (d) => d.usdg },
  eth: { label: "ETH", decimals: 18, daily: "0.001", amount: ethers.parseEther("0.001"), tokenOf: () => undefined },
};

const utcDay = () => new Date().toISOString().slice(0, 10);

/// The claim message. The client signs exactly this with the connected wallet; the API recovers
/// the signer, so a claim is provably made by the address it claims FOR -- no claiming for
/// someone else, and the day in the message stops a signature being replayed tomorrow.
function claimMessage(address: string, asset: Asset, day: string): string {
  return `Levera faucet claim\n${asset} ${day}\n${address.toLowerCase()}`;
}

function json(data: unknown, status = 200) {
  return Response.json(data, { status });
}

function provider() {
  return new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
}

async function potStatus() {
  const dep = deploymentRecord();
  const p = provider();
  const wallet = faucetWallet(p);
  const faucetAddress = await wallet.getAddress();
  const potEth = await p.getBalance(faucetAddress);
  const tokenAddresses = Object.fromEntries(
    (Object.keys(ASSETS) as Asset[]).map((a) => [a, ASSETS[a].tokenOf(dep) ?? ""]),
  );
  return { dep, p, wallet, faucetAddress, potEth, tokenAddresses };
}

export async function GET(request: Request) {
  try {
    const { faucetAddress, potEth, tokenAddresses } = await potStatus();
    const address = new URL(request.url).searchParams.get("address")?.toLowerCase() ?? "";
    let claims: Record<string, string> = {};
    if (ethers.isAddress(address)) {
      for (const asset of Object.keys(ASSETS) as Asset[]) {
        const rec = await getFaucetClaim(address, asset, utcDay()).catch(() => null);
        if (rec) claims[asset] = rec.tx;
      }
    }
    return json({
      network: TARGETING_TESTNET ? "robinhood-testnet" : "local-fork",
      faucetAddress,
      potEth: potEth.toString(),
      tokens: tokenAddresses,
      limits: Object.fromEntries((Object.keys(ASSETS) as Asset[]).map((a) => [a, ASSETS[a].daily])),
      claimedToday: claims,
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const address = String(body?.address ?? "");
    const asset = String(body?.asset ?? "") as Asset;
    const signature = String(body?.signature ?? "");
    if (!ethers.isAddress(address)) return json({ error: "Invalid wallet address." }, 400);
    if (!ASSETS[asset]) return json({ error: "Unknown asset." }, 400);
    if (!signature) return json({ error: "Sign the claim in your wallet to continue." }, 400);

    const day = utcDay();
    let signer_: string;
    try {
      signer_ = ethers.verifyMessage(claimMessage(address, asset, day), signature);
    } catch {
      return json({ error: "Invalid claim signature." }, 401);
    }
    if (signer_.toLowerCase() !== address.toLowerCase()) {
      return json({ error: "Signature does not match the claiming address." }, 401);
    }
    const existing = await getFaucetClaim(address, asset, day);
    if (existing) {
      return json({ error: `Already claimed ${ASSETS[asset].label} today. Resets at midnight UTC.`, claimedToday: true }, 429);
    }

    const { dep, p, wallet, faucetAddress, potEth, tokenAddresses } = await potStatus();
    const { amount } = ASSETS[asset];
    let txHash = "";

    if (asset === "eth") {
      const gasReserve = ethers.parseEther("0.0002");
      if (potEth < amount + gasReserve) {
        return json(
          { error: "The community ETH pot is dry. Contribute ETH on this page so others can claim." },
          503,
        );
      }
      const tx = await wallet.sendTransaction({ to: address, value: amount, gasLimit: 100_000n });
      const rc = await tx.wait();
      if (rc?.status !== 1) throw new Error("ETH transfer failed");
      txHash = rc.hash;
    } else {
      const token = tokenAddresses[asset];
      if (!token) return json({ error: `${ASSETS[asset].label} is not part of this deployment.` }, 400);
      // Fail with a reason, not a raw revert dump: a faucet wallet without the role is a deploy
      // wiring gap (the role is granted per-token at deploy time, to the key in testnet/.env --
      // if Vercel's FAUCET_PRIVATE_KEY is a different address, minting reverts for exactly this).
      const abi = ["function MINTER_ROLE() view returns (bytes32)", "function hasRole(bytes32,address) view returns (bool)"];
      const rw = new ethers.Contract(token, abi, p);
      const role: string = await rw.MINTER_ROLE();
      if (!(await rw.hasRole(role, faucetAddress))) {
        return json(
          {
            error:
              `The faucet wallet (${faucetAddress}) has no MINTER_ROLE on ${ASSETS[asset].label}. ` +
              "The deployment granted the role to a different key -- align FAUCET_PRIVATE_KEY with testnet/.env, " +
              "or grant the role to this address (see testnet/deploy.mjs).",
          },
          503,
        );
      }
      const t = new ethers.Contract(token, ["function mint(address,uint256)"], wallet);
      const rc = await (await t.mint(address, amount, { gasLimit: 300_000n })).wait();
      if (rc?.status !== 1) throw new Error("mint failed");
      txHash = rc.hash;
    }

    await recordFaucetClaim({ address, asset, day, amount: amount.toString(), tx: txHash, t: Date.now() });
    void dep; void faucetAddress;
    return json({ ok: true, asset, amount: amount.toString(), tx: txHash });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
}
