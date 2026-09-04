import { Contract, type ContractRunner } from "ethers";

/// ethers v6 types dynamic Contract members as possibly-undefined — a generic Contract cannot
/// know which functions its ABI carries. Every wrapper here uses a human-readable ABI written
/// against contracts/src and exposes a method interface, so a wrong signature is a type error
/// at THIS cast instead of a possibly-undefined call at every use site.
export function contractWith<M>(address: string, abi: readonly string[], runner: ContractRunner): Contract & M {
  return new Contract(address, abi, runner) as unknown as Contract & M;
}
