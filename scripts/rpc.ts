/* Shared testnet JSON-RPC endpoint for the operational scripts. The official
   fullnode (fullnode.testnet.sui.io) is gRPC-only now — its JSON-RPC returns
   404 — so scripts default to a public endpoint that still serves JSON-RPC.
   Override with SUI_RPC_URL. */
export const TESTNET_JSONRPC_URL =
  process.env.SUI_RPC_URL ?? 'https://rpc-testnet.suiscan.xyz:443';
