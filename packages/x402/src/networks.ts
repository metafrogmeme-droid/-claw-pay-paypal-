// x402 v1 network names → CAIP-2, from the x402 npm package 1.2.0 (Apache-2.0,
// tarball sha256 66d586c18d0b44f8a66b0688f9df13273b3a13c14613be2ac624749fe34853d8), src/types/shared/network.ts
// `EvmNetworkToChainId`. EVM only: its Solana ids (101/103) are not CAIP-2, so Solana names stay unreadable.
// Any name not in this table is REQUIREMENTS_UNREADABLE; we never guess.

const EVM_CHAIN_IDS: Readonly<Record<string, number>> = {
  abstract: 2741,
  'abstract-testnet': 11124,
  'base-sepolia': 84532,
  base: 8453,
  'avalanche-fuji': 43113,
  avalanche: 43114,
  iotex: 4689,
  sei: 1329,
  'sei-testnet': 1328,
  polygon: 137,
  'polygon-amoy': 80002,
  peaq: 3338,
  story: 1514,
  educhain: 41923,
  'skale-base-sepolia': 324705682,
};

export const V1_NETWORKS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(EVM_CHAIN_IDS).map(([name, id]) => [name, `eip155:${String(id)}`])),
);
