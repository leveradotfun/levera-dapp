# Robinhood Chain testnet deployment

Deploys the full HoodFrenzy stack to **Robinhood Chain testnet** (chain `46630`) — both launchpads (WETH-quoted and cbBTC-quoted), the Earn Pool, oracles, routers, and the quote zap — and publishes `data/deployment-testnet.json` where both apps can read it.

This folder exists so the testnet path never has to touch `contracts/`: nothing here changes protocol source, it only composes artifacts that `forge build` already compiled. It is the documented "mock prototype" path (`docs/security/testnet.mdx`) with the deploy gap filled.

## What is real here, and what is not

| Component | Status |
|---|---|
| Chain | Real Robinhood testnet (46630), real explorer, real faucet ETH |
| Prices | **Real market values**, read from Robinhood **mainnet's** Chainlink feeds at deploy time and seeded into the mock oracles (testnet has no feeds of its own — every mainnet address is empty code there). `refresh-prices.mjs` re-syncs them on demand |
| WETH, USDG, cbBTC tokens | Mocks. USDG is 18 decimals (live mainnet USDG is 6 — never copy this to mainnet). cbBTC is an 8-decimal stand-in; no official cbBTC exists on 46630 |
| Oracles | `MockPriceOracle`, owner-settable, seeded with the real market and refreshable |
| Router | `OracleSwapRouter` — fills from inventory first, mints only the shortfall (role-gated, granted to each router at deploy) — so there is no inventory to pre-fund and no AMM to bootstrap |
| Earn Pool / Launch / factories | The real contracts, unchanged, including the multi-collateral registry and **both** launchpads authorised on the pool |

The result is a chain where every number the protocol computes is computed correctly — the ETH price is the actual ETH price, cbBTC is actually 8 decimals — even though the tokens themselves are mocks.

## Deploy

```bash
cd testnet
cp .env.example .env          # add DEPLOYER_PRIVATE_KEY
npm install
node deploy.mjs               # or: npm run deploy
node verify.mjs               # wiring checks; add --probe-launch to also create a throwaway coin
```

1. Fund the deployer from the faucet: <https://faucet.testnet.chain.robinhood.com> (the full stack is ~15 deployments, but testnet gas is near-free — the whole thing costs ~0.0003 ETH; the script refuses to start under 0.002 ETH).
2. `DEPLOYER_PRIVATE_KEY` — a testnet-only key. It will own every contract (Earn Pool owner, both factory owners, the oracles). Never a mainnet key.
3. Contract bytecode comes from `contracts/out/` — run `forge build` in `contracts/` first if it is missing.

### Redeploy (fresh addresses, e.g. after rotating a leaked key)

Every command below is run from `testnet/` unless noted. Redeploying overwrites `data/deployment-testnet.json` — every user's `frontend`/`ui` tab picks up the new addresses automatically on its next poll, no restart needed on their end.

1. **You're in `contracts/`.** Make sure the build is current and matches the committed lock file:
   ```bash
   cd contracts
   forge build
   node hash-artifacts.mjs check
   ```
   If `check` reports drift, that means `src/` changed since the lock file was last approved. Review the diff, then (still in `contracts/`) `node hash-artifacts.mjs write` and commit the updated `artifacts.lock.json` before deploying — `deploy.mjs` will refuse otherwise.

2. **You're in `testnet/`.** If you're rotating the deployer key (recommended if the old one may have been exposed — e.g. it sat behind an ops route, or a laptop with `.env` on it was shared):
   ```bash
   cd testnet
   node -e "console.log(require('ethers').Wallet.createRandom().privateKey)"
   ```
   Copy the printed key into `DEPLOYER_PRIVATE_KEY` in `.env` (open the file directly — there is no script for this, it holds a secret). Fund the new address with ≥ 0.002 ETH, either from the public faucet above, or — if you already control a funded key on this deployment (e.g. the faucet wallet) — by sending it directly:
   ```bash
   node -e '
   import("ethers").then(async ({ ethers }) => {
     const provider = new ethers.JsonRpcProvider("https://rpc.testnet.chain.robinhood.com", undefined, { staticNetwork: true });
     const sender = new ethers.Wallet("0x<a funded private key>", provider);
     const tx = await sender.sendTransaction({ to: "0x<new deployer address>", value: ethers.parseEther("0.01"), gasLimit: 30000n });
     console.log((await tx.wait()).hash);
   });'
   ```
   If you're sweeping the OLD deployer's leftover balance somewhere before abandoning the key, same pattern — `sender` is the old key, send its balance minus gas to wherever it should go.

3. **You're in `testnet/`.**
   ```bash
   node deploy.mjs
   ```
   This checks the bytecode lock file itself before deploying anything, so step 1 is a courtesy, not a strict prerequisite — but running it first means you find out about drift before spending any gas.

4. **You're in `testnet/`.**
   ```bash
   node verify.mjs
   ```
   All checks should pass. If `mint() is gated` fails for any token, or ownership isn't the address you expect, stop and investigate before pointing users at it.

5. **Nothing to do here** — `frontend/.env.local` and `ui/.env.local` already point `NEXT_PUBLIC_RPC_URL` at the testnet RPC (if either doesn't, see "Point the apps at it" below); both read `data/deployment-testnet.json` by `updatedAt` on their own.

### Price seeding

At deploy the harness reads the **real** ETH/USD, USDG/USD and CBBTC/USD feeds straight off Robinhood mainnet with plain `eth_call` (no fork needed) and seeds the mock oracles with them:

- `MockPriceOracle (ETH)` — `price()` = live ETH/USD, `cashPrice()` = live USDG/USD
- `MockPriceOracle (cbBTC)` — `price()` = live CBBTC/USD, `cashPrice()` = live USDG/USD

Pins in `.env` (`TESTNET_ETH_USD`, `TESTNET_USDG_USD`, `TESTNET_CBBTC_USD`, decimal dollars) override the live read. ETH and cbBTC **fail closed** — if the feed cannot be read and there is no pin, the deploy aborts, because a wrong collateral price poisons every valuation on the chain. USDG falls back to $1.00 with a warning, matching the app's own behaviour when the cash feed is unread.

Prices are a **snapshot**, not a stream. Re-sync whenever you want them current (cron-friendly, one tx per oracle):

```bash
node refresh-prices.mjs
```

### Verify

`node verify.mjs` checks, read-only: chain id, bytecode integrity against the committed lock file (see below), every address in the record actually has code, ownership (and whether it's a bare EOA rather than a multisig), that `mint()` on each token is actually gated, that the `Launch` implementation is locked, both factories deployed **and** authorised on the Earn Pool (the registry bug that made every cbBTC launch revert), both collaterals listed and enabled with sane caps, each oracle marked at the real market **and fresh**, and the Earn Pool unpaused. `--probe-launch` additionally creates a 2x cbBTC coin through the real factory path — the exact regression that broke the UI — and leaves one junk coin on testnet, which is acceptable exactly there and nowhere else; it is the one thing this script signs, everything else is read-only.

### Bytecode integrity

`contracts/artifacts.lock.json` pins the creation-bytecode hash of every contract this stack deploys, so a local edit, a bad merge, or a stale `contracts/out/` can't reach chain looking identical to reviewed source.

```bash
node hash-artifacts.mjs check    # read-only: diff contracts/out/ against the committed lock file
node hash-artifacts.mjs write    # regenerate it from the current build — only after review
```

`deploy.mjs` runs the check automatically and refuses to deploy on any drift or unpinned contract. After reviewing a `contracts/src` change, run `write` and commit the updated `contracts/artifacts.lock.json` in the *same* change — the file is the record of what was approved, not just what compiled.

The canonical script is `contracts/hash-artifacts.mjs` (zero dependencies, self-contained); this directory's `hash-artifacts.mjs` is a thin passthrough to it, for convenience from wherever you're already doing deploy work. `contracts/.github/workflows/bytecode-lock.yml` runs `check` in CI on any push or PR touching `contracts/src` — scoped entirely inside the `contracts/` repo on purpose, since `contracts/`, `ui/`, and `landing-page/` are deliberately independent git repositories that don't intertwine with this one or each other.

The published `data/deployment-testnet.json` also records the hash each contract deployed with (`artifactHashes`), so `verify.mjs` can later confirm the live deployment still matches what was reviewed, independent of whatever happens to be in `contracts/out/` at the time someone checks.

## Point the apps at it

The app target is one variable: `NEXT_PUBLIC_RPC_URL`.

```bash
# frontend/.env.local  (and ui/.env.local for the console)
NEXT_PUBLIC_RPC_URL=https://rpc.testnet.chain.robinhood.com
```

Setting that to the testnet RPC switches everything together — the ethers provider, the wagmi/wallet transport for 46630, the localStorage deployment key (`launchpad-ui:deployed-addresses:testnet`), and the deployment file the app polls (`GET /api/deployment?chain=testnet` reads `data/deployment-testnet.json`). Fork addresses cannot leak into a testnet tab or the reverse, because the two targets use different storage keys and different files.



## Deployed addresses

`data/deployment.json` (fork) and `data/deployment-testnet.json` (testnet) share a shape, with the testnet file adding `network`, `chainId`, `explorer`, the two mock-oracle addresses (`oracleEth`, `oracleCbbtc` — needed by `refresh-prices.mjs`) and the `seededPrices` record. Re-running `deploy.mjs` overwrites the file; the apps pick the new deployment up by `updatedAt` automatically.

## Not solved here

- **Keepers**: graduation/rebalance automation still dies with the browser tab. Run them from a funded process (see `docs/security/testnet.mdx`).
- **Real cbBTC**: when Coinbase deploys an official token on Robinhood Chain, redeploy the cbBTC launchpad against it — the launchpad takes the token address at construction, so that is one constructor argument, not a migration.
- **Mainnet**: still a manual, reviewed process. The 6-decimal USDG on mainnet is a real code path the mocks never exercise.
