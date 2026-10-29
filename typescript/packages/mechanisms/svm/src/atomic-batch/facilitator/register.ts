import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { FacilitatorSvmSigner } from "../../signer";
import { SettlementCache } from "../../settlement-cache";
import { AtomicBatchSvmScheme, type AtomicBatchSvmSchemeOptions } from "./scheme";

/**
 * Configuration options for registering the SVM atomic-batch scheme to an x402Facilitator
 */
export interface SvmFacilitatorConfig {
  /**
   * The SVM signer for facilitator operations (relays settled batches)
   */
  signer: FacilitatorSvmSigner;

  /**
   * Optional specific networks to register (defaults to all Solana networks)
   */
  networks?: Network[];

  /**
   * Optional RPC endpoint for on-chain reads during verification
   */
  rpcUrl?: string;
}

/**
 * Registers the SVM atomic-batch payment scheme to an existing x402Facilitator instance.
 *
 * @param facilitator - The x402Facilitator instance to register schemes to
 * @param config - Configuration for SVM facilitator registration
 * @returns The facilitator instance for chaining
 */
export function registerAtomicBatchSvmScheme(
  facilitator: x402Facilitator,
  config: SvmFacilitatorConfig,
): x402Facilitator {
  const options: AtomicBatchSvmSchemeOptions = { rpcUrl: config.rpcUrl };
  const settlementCache = new SettlementCache();

  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      facilitator.register(
        network,
        new AtomicBatchSvmScheme(config.signer, settlementCache, options),
      );
    });
  } else {
    facilitator.register(
      "solana:*",
      new AtomicBatchSvmScheme(config.signer, settlementCache, options),
    );
  }

  return facilitator;
}
