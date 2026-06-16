import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { enokiWalletsInitializer } from "@mysten/enoki";

const GRPC_URLS = {
  testnet: "https://fullnode.testnet.sui.io:443",
} as const;

export const dAppKit = createDAppKit({
  networks: ["testnet"],
  defaultNetwork: "testnet",
  createClient: (network) =>
    new SuiGrpcClient({ network, baseUrl: GRPC_URLS[network] }),
  // Enoki registers zkLogin wallets ("Sign in with Google") via the standard
  // wallet registry; dApp Kit auto-detects them. The initializer is handed the
  // kit's own client + network, so Enoki shares the same gRPC client.
  walletInitializers: [
    enokiWalletsInitializer({
      apiKey: process.env.NEXT_PUBLIC_ENOKI_API_KEY!,
      providers: {
        google: {
          clientId: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID!,
          // One stable redirect target so a single URL is registered in
          // Google + Enoki. Implicit flow (id_token) → no client secret.
          redirectUrl:
            typeof window !== "undefined"
              ? `${window.location.origin}/auth/callback`
              : undefined,
        },
      },
    }),
  ],
});

// Register the instance so dApp Kit hooks infer networks/client types.
declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
