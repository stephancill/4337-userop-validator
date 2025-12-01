import { createConfig, http } from "wagmi";
import * as allChains from "viem/chains";
import type { Chain } from "viem";

// Get all chains from viem/chains (filter out non-chain exports)
const chainList = (Object.values(allChains) as any[]).filter(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "name" in value &&
    typeof value.id === "number"
) as Chain[];

export const supportedChains = chainList as unknown as readonly [
  Chain,
  ...Chain[],
];

// Build transports object for all chains
const transports = Object.fromEntries(
  chainList.map((chain) => [chain.id, http()])
) as Record<number, ReturnType<typeof http>>;

export const config = createConfig({
  chains: supportedChains,
  transports,
});

declare module "wagmi" {
  interface Register {
    config: typeof config;
  }
}
