import { x402ResourceServer } from "@x402/core/server";
import { Network } from "@x402/core/types";
import { AtomicBatchSvmScheme } from "./scheme";

/**
 * Configuration options for registering the SVM atomic-batch scheme to an x402ResourceServer
 */
export interface SvmResourceServerConfig {
  /**
   * Optional specific networks to register
   */
  networks?: Network[];
}

/**
 * Registers the SVM atomic-batch payment scheme to an existing x402ResourceServer instance.
 *
 * @param server - The x402ResourceServer instance to register schemes to
 * @param config - Configuration for SVM resource server registration
 * @returns The server instance for chaining
 */
export function registerAtomicBatchSvmScheme(
  server: x402ResourceServer,
  config: SvmResourceServerConfig = {},
): x402ResourceServer {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      server.register(network, new AtomicBatchSvmScheme());
    });
  } else {
    server.register("solana:*", new AtomicBatchSvmScheme());
  }

  return server;
}
