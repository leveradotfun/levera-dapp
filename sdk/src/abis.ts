/// Human-readable ABIs for every surface the SDK touches, kept to exactly the functions the
/// wrappers call. Verified against contracts/src — extend with care and re-check the .sol, since
/// a renamed on-chain function only fails at the first call, far from the cause.

export const ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;

/// Faucet mint on the testnet mocks. Fails with "missing revert data" on any real token.
export const MINTABLE_ABI = ["function mint(address to, uint256 amount)"] as const;

export const WETH_ABI = [
  ...ERC20_ABI,
  ...MINTABLE_ABI,
  "function deposit() payable",
  "function withdraw(uint256 amount)",
] as const;

export const PRICE_ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function conf() view returns (uint256)",
  "function publishedAt() view returns (uint256)",
  "function cashPrice() view returns (uint256)",
  "function cashConf() view returns (uint256)",
  "function cashPublishedAt() view returns (uint256)",
] as const;

export const LAUNCHPAD_FACTORY_ABI = [
  "function implementation() view returns (address)",
  "function collateralToken() view returns (address)",
  "function usdgToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function priceOracle() view returns (address)",
  "function earn() view returns (address)",
  "function pairFactory() view returns (address)",
  "function protocolFeeRecipient() view returns (address)",
  "function minRaise() view returns (uint256)",
  "function creatorBuyCapBps() view returns (uint256)",
  "function launchCount() view returns (uint256)",
  "function getLaunch(uint256 index) view returns (address)",
  "function allLaunches(uint256 index) view returns (address)",
  "function getLaunchesByCreator(address creator) view returns (address[])",
  "function createLaunch(string name, string symbol, uint256 targetRaiseQuote, bool creatorFeeInHfyc, bool leverageEnabled) returns (address launch)",
  "function createLaunch(string name, string symbol, uint256 targetRaiseQuote, bool creatorFeeInHfyc, bool leverageEnabled, uint256 creatorBuyIn, uint256 creatorMinTokensOut) returns (address launch)",
  "event LaunchCreated(address indexed launch, address indexed creator, string name, string symbol, uint256 targetRaiseUsd, bool creatorFeeInHfyc, bool leverageEnabled)",
  "event CreatorDevBuy(address indexed launch, address indexed creator, uint256 quoteIn, uint256 tokensOut)",
  "event CreatorBuyCapSet(uint256 bps)",
  "event ProtocolFeeRecipientUpdated(address indexed previous, address indexed current)",
] as const;

export const LAUNCH_ABI = [
  // ERC-20 surface of the coin itself
  ...ERC20_ABI,
  // wiring, fixed at construction
  "function quote() view returns (address)",
  "function quoteScale() view returns (uint256)",
  "function pairFactory() view returns (address)",
  "function usdgToken() view returns (address)",
  "function swapRouter() view returns (address)",
  "function priceOracle() view returns (address)",
  "function earn() view returns (address)",
  "function creator() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function creatorFeeInHfyc() view returns (bool)",
  "function leverageEnabled() view returns (bool)",
  "function targetRaiseEth() view returns (uint256)",
  "function targetRaiseUsdAtCreation() view returns (uint256)",
  // curve phase
  "function curveSellable() view returns (uint256)",
  "function virtualTokens() view returns (uint256)",
  "function virtualEth() view returns (uint256)",
  "function curveK() view returns (uint256)",
  "function realEthRaised() view returns (uint256)",
  "function graduated() view returns (bool)",
  // amm / senior bookkeeping
  "function amm() view returns (address)",
  "function reserveEth() view returns (uint256)",
  "function reserveToken() view returns (uint256)",
  "function vaultEth() view returns (uint256)",
  "function poolEth() view returns (uint256)",
  "function juniorEth() view returns (uint256)",
  "function seniorUsd() view returns (uint256)",
  "function paired() view returns (bool)",
  "function seniorAtPair() view returns (uint256)",
  "function utilizationAtPair() view returns (uint256)",
  "function occupancyPaidUsd() view returns (uint256)",
  "function pairingFeesPaidUsd() view returns (uint256)",
  // supply, price, nav
  "function TOTAL_SUPPLY() view returns (uint256)",
  "function CURVE_SELLABLE() view returns (uint256)",
  "function TOTAL_FEE_BPS() view returns (uint256)",
  "function circulating() view returns (uint256)",
  "function priceUsd() view returns (uint256)",
  "function tvlUsd() view returns (uint256)",
  "function memeNAV() view returns (uint256)",
  "function navPerToken() view returns (uint256)",
  "function leverageWad() view returns (uint256)",
  "function crWad() view returns (uint256)",
  "function recentVolumeUsd() view returns (uint256)",
  "function tradeFeeBps(bool arriving) view returns (uint256)",
  "function seniorClaimEth() view returns (uint256)",
  "function seniorCoverageWad() view returns (uint256)",
  "function reserveCoverWad() view returns (uint256)",
  // fees
  "function creatorFeeQuote() view returns (uint256)",
  "function protocolFeeQuote() view returns (uint256)",
  "function holderFeeQuote() view returns (uint256)",
  "function lifetimeCreatorFeeQuote() view returns (uint256)",
  // trading
  "function buy(uint256 amountIn, uint256 minTokensOut) returns (uint256 tokensOut)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut) returns (uint256 quoteOut)",
  "function buyOnPool(uint256 quoteIn, uint256 minTokensOut) returns (uint256 tokensOut)",
  "function sellOnPool(uint256 tokensIn, uint256 minQuoteOut) returns (uint256 quoteOut)",
  // lifecycle (permissionless keeper actions)
  "function graduate()",
  "function tryPair() returns (bool)",
  "function tryPairUpTo(uint256 maxUsd) returns (bool)",
  "function protect() returns (uint256 ethSold, uint256 usdReceived)",
  "function harvest() returns (uint256 holderUsd, uint256 protocolUsd, uint256 creatorUsd)",
  "function accrueFunding()",
  "function rebalanceToReserve() returns (uint256 ethMoved)",
  "function reallocateFrom(address fromPool, uint256 usdAmount) returns (uint256)",
  "function claimCreatorFees() returns (uint256 amount)",
  // events
  "event CurveBuy(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 feeEth)",
  "event CurveSell(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 feeEth)",
  "event PoolBuy(address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 feeEth)",
  "event PoolSell(address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 feeEth)",
  "event Graduated(uint256 ethRaised, bool pairedNow)",
  "event Paired(uint256 seniorUsd, uint256 juniorUsd, uint256 ethFromQueue)",
  "event CreatorFeesClaimed(address indexed creator, uint256 ethAmount)",
] as const;

export const EARN_POOL_ABI = [
  ...ERC20_ABI,
  "function mintWithUsdg(uint256 usdAmount) returns (uint256 hfycOut)",
  "function mintWithEth() payable returns (uint256 hfycOut)",
  "function redeem(uint256 shares) returns (uint256 usdgOut)",
  "function unlockedBalanceOf(address user) view returns (uint256)",
  "function maxRedeemableShares(address holder) view returns (uint256)",
  "function nav() view returns (uint256)",
  "function utilizationWad() view returns (uint256)",
  "function fundingRateWad() view returns (uint256)",
  "function fundingRateFor(address token) view returns (uint256)",
  "function globalCr() view returns (uint256)",
  "function totalAssetsUsd() view returns (uint256)",
  "function collateralPriceUsd() view returns (uint256)",
  "function oracleLive() view returns (bool)",
  "function earnPoolApyWad() view returns (uint256)",
  "function earnPoolWindow() view returns (uint256 yieldUsd, uint256 elapsed, uint256 baseLiability)",
  "function poolCount() view returns (uint256)",
  "function collateralCount() view returns (uint256)",
  "event Minted(address indexed user, uint256 usdValue, uint256 hfycOut, bool paidInEth)",
  "event Redeemed(address indexed user, uint256 shares, uint256 usdgOut, uint256 wethOut, bool covered)",
] as const;

export const QUOTE_ZAP_ABI = [
  "function weth() view returns (address)",
  "function buyWithEth(address launch, uint256 minTokensOut) payable returns (uint256 tokensOut)",
  "function sellForEth(address launch, uint256 tokensIn, uint256 minEthOut) returns (uint256 ethOut)",
] as const;

export const SWAP_ROUTER_ABI = [
  "function collateral() view returns (address)",
  "function usdg() view returns (address)",
  "function oracle() view returns (address)",
  "function swapUsdgForCollateral(uint256 usdgIn, uint256 minCollateralOut) returns (uint256)",
  "function swapCollateralForUsdg(uint256 collateralIn, uint256 minUsdgOut) returns (uint256)",
  "event Swap(address indexed caller, bool collateralForUsdg, uint256 amountIn, uint256 amountOut)",
] as const;

/// USDG→quote is a state-changing call, so the filled amount is only available from the Swap
/// event — there is no return value to read off a mined transaction.
export const SWAP_EVENT_ABI = ["event Swap(address indexed caller, bool collateralForUsdg, uint256 amountIn, uint256 amountOut)"] as const;
