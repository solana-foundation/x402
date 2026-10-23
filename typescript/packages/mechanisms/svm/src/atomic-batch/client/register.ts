import { x402Client, SelectPaymentRequirements, PaymentPolicy } from "@x402/core/client";
import { Network } from "@x402/core/types";
import { ClientSvmSigner } from "../../signer";
import { AtomicBatchSvmScheme } from "./scheme";

/**
 * Configuration options for registering the SVM atomic-batch scheme to an x402Client
 */
export interface SvmClientConfig {
  /**
   * The SVM signer to use for creating payment payloads
   */
  signer: ClientSvmSigner;

  /**
   * Optional payment requirements selector function
   */
  paymentRequirementsSelector?: SelectPaymentRequirements;

  /**
   * Optional policies to apply to the client
   */
  policies?: PaymentPolicy[];

  /**
   * Optional specific networks to register
   */
  networks?: Network[];
}

/**
 * Registers the SVM atomic-batch payment scheme to an existing x402Client instance.
 *
 * @param client - The x402Client instance to register schemes to
 * @param config - Configuration for SVM client registration
 * @returns The client instance for chaining
 */
export function registerAtomicBatchSvmScheme(
  client: x402Client,
  config: SvmClientConfig,
): x402Client {
  if (config.networks && config.networks.length > 0) {
    config.networks.forEach(network => {
      client.register(network, new AtomicBatchSvmScheme(config.signer));
    });
  } else {
    client.register("solana:*", new AtomicBatchSvmScheme(config.signer));
  }

  if (config.policies) {
    config.policies.forEach(policy => {
      client.registerPolicy(policy);
    });
  }

  return client;
}
