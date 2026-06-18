import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { UptoSvmScheme } from "./scheme";

/** Configuration for registering the upto SVM server scheme to an x402ResourceServer. */
export interface UptoSvmResourceServerConfig {
  /** Optional specific networks (defaults to the `solana:*` family). */
  networks?: Network[];
}

/**
 * Register the upto SVM server scheme on an existing x402ResourceServer.
 *
 * @param server - The x402ResourceServer to register on
 * @param config - Resource-server configuration
 * @returns The server for chaining
 */
export function registerUptoSvmScheme(
  server: x402ResourceServer,
  config: UptoSvmResourceServerConfig = {},
): x402ResourceServer {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => server.register(network, new UptoSvmScheme()));
  } else {
    server.register("solana:*", new UptoSvmScheme());
  }
  return server;
}
