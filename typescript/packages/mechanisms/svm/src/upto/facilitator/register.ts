import { x402Facilitator } from "@x402/core/facilitator";
import { Network } from "@x402/core/types";
import { type OperatorSigner } from "./channel";
import { UptoSvmScheme } from "./scheme";

/** Configuration for registering the upto SVM facilitator scheme to an x402Facilitator. */
export interface UptoSvmFacilitatorRegisterConfig {
  /** The operator signer: channel authorized signer, fee payer, and voucher signer. */
  operator: OperatorSigner;
  /** Networks to register (single network or array). */
  networks: Network | Network[];
  /** Optional custom RPC URL. */
  rpcUrl?: string;
}

/**
 * Register the upto SVM facilitator scheme on an existing x402Facilitator.
 *
 * @param facilitator - The x402Facilitator to register on
 * @param config - Facilitator configuration
 * @returns The facilitator for chaining
 */
export function registerUptoSvmScheme(
  facilitator: x402Facilitator,
  config: UptoSvmFacilitatorRegisterConfig,
): x402Facilitator {
  facilitator.register(
    config.networks,
    new UptoSvmScheme(config.operator, config.rpcUrl ? { rpcUrl: config.rpcUrl } : undefined),
  );
  return facilitator;
}
