import { type ContractTransactionResponse, MaxUint256 } from "ethers";
import { ERC20_ABI } from "./abis.js";
import { contractWith } from "./contract.js";
import type { ContractRunner } from "ethers";

type Erc20Methods = {
  symbol(): Promise<string>;
  decimals(): Promise<bigint>;
  totalSupply(): Promise<bigint>;
  balanceOf(owner: string): Promise<bigint>;
  allowance(owner: string, spender: string): Promise<bigint>;
  approve(spender: string, amount: bigint, overrides?: Record<string, unknown>): Promise<ContractTransactionResponse>;
  transfer(to: string, amount: bigint, overrides?: Record<string, unknown>): Promise<ContractTransactionResponse>;
  transferFrom(from: string, to: string, amount: bigint, overrides?: Record<string, unknown>): Promise<ContractTransactionResponse>;
};

export class Erc20 {
  readonly contract: Erc20Methods;
  readonly address: string;

  constructor(address: string, runner: ContractRunner) {
    this.address = address;
    this.contract = contractWith<Erc20Methods>(address, ERC20_ABI, runner);
  }

  async symbol(): Promise<string> {
    return this.contract.symbol();
  }

  async decimals(): Promise<number> {
    return Number(await this.contract.decimals());
  }

  async balanceOf(owner: string): Promise<bigint> {
    return this.contract.balanceOf(owner);
  }

  async allowance(owner: string, spender: string): Promise<bigint> {
    return this.contract.allowance(owner, spender);
  }

  /// True when the allowance is short of `amount`. Read-only.
  async needsApproval(owner: string, spender: string, amount: bigint): Promise<boolean> {
    return (await this.allowance(owner, spender)) < amount;
  }

  /// Approve only if the current allowance is short, then WAIT for the receipt. `amount`
  /// defaults to infinity, matching the app: one approval instead of one per trade. Pass a
  /// finite amount for tighter wallets. Returns null when no approval was needed.
  async ensureApproval(
    owner: string,
    spender: string,
    amount: bigint = MaxUint256,
    overrides: Record<string, unknown> = {}
  ): Promise<null | { hash: string }> {
    if (!(await this.needsApproval(owner, spender, amount))) return null;
    const tx = await this.contract.approve(spender, amount, overrides);
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error(`approval to ${spender} reverted (tx ${tx.hash})`);
    return { hash: tx.hash };
  }
}

/// Faucet mint on the testnet mocks (deployer-owned). Fails on any real token.
export async function faucetMint(
  tokenAddress: string,
  to: string,
  amount: bigint,
  runner: ContractRunner
): Promise<{ hash: string }> {
  const token = contractWith<{ mint(to: string, amount: bigint): Promise<ContractTransactionResponse> }>(
    tokenAddress,
    [...ERC20_ABI, "function mint(address to, uint256 amount)"],
    runner
  );
  const tx = await token.mint(to, amount);
  return { hash: tx.hash };
}
