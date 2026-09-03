import { ethers } from "ethers";
import { getProvider } from "./signers";

const PRICE_ORACLE_ABI = [
  "function price() view returns (uint256)",
  "function cashPrice() view returns (uint256)",
];

const AGGREGATOR_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];

function scaleToWad(answer: bigint, decimals: number): bigint {
  if (answer <= 0n) return 0n;
  if (decimals === 18) return answer;
  if (decimals < 18) return answer * 10n ** BigInt(18 - decimals);
  return answer / 10n ** BigInt(decimals - 18);
}

async function readAggregatorWad(address: string): Promise<bigint> {
  const agg = new ethers.Contract(address, AGGREGATOR_ABI, getProvider());
  const [, answer] = await agg.latestRoundData();
  const decimals: number = Number(await agg.decimals());
  return scaleToWad(BigInt(answer), decimals);
}

export async function readEthUsdWad(oracleAddress: string | undefined | null): Promise<bigint> {
  if (!oracleAddress || oracleAddress === ethers.ZeroAddress) return 0n;
  const oracle = new ethers.Contract(oracleAddress, PRICE_ORACLE_ABI, getProvider());
  try {
    const p: bigint = await oracle.price();
    if (p > 0n) return p;
  } catch {
    // not IPriceOracle.price()
  }
  try {
    return await readAggregatorWad(oracleAddress);
  } catch {
    return 0n;
  }
}
