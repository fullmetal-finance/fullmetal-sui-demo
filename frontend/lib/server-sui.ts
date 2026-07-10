/* SERVER-ONLY JSON-RPC client for the API routes (keeper/faucet/maker txs).
   The official testnet fullnode is gRPC-only now (JSON-RPC returns 404), so
   server reads/writes go to a public JSON-RPC endpoint. Override with
   SUI_RPC_URL (server env), which wins over the public default. */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";

const SERVER_TESTNET_JSONRPC_URL =
  process.env.SUI_RPC_URL ??
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  "https://rpc-testnet.suiscan.xyz:443";

export function serverSuiClient(): SuiJsonRpcClient {
  return new SuiJsonRpcClient({ network: "testnet", url: SERVER_TESTNET_JSONRPC_URL });
}
