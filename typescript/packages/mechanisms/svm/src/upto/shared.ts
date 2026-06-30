import type { PaymentRequirements } from "@x402/core/types";

import type { ChannelSplit } from "../payment-channels/open";
import { UPTO_ASSET_TRANSFER_METHOD } from "../types";

const BASIS_POINTS_DENOMINATOR = 10_000;

/** Resolved payment-channel fields derived from SVM `upto` requirements. */
export interface UptoSvmPaymentChannelConfig {
  /** Channel operator: facilitator address when delegated, otherwise payTo. */
  operator: string;
  /** Facilitator fee in basis points of the settled amount. */
  facilitatorFee: number;
  /** Program distribution recipients sealed into open and replayed at distribute. */
  splits: readonly ChannelSplit[];
}

/**
 * Resolve and validate the SVM `upto` payment-channel discriminator fields.
 *
 * @param requirements - Payment requirements carrying `extra.assetTransferMethod`
 * @returns Operator, facilitator fee, and payment-channel split recipients
 */
export function resolveUptoSvmPaymentChannelConfig(
  requirements: PaymentRequirements,
): UptoSvmPaymentChannelConfig {
  if (requirements.extra?.assetTransferMethod !== UPTO_ASSET_TRANSFER_METHOD) {
    throw new Error(`assetTransferMethod must be ${UPTO_ASSET_TRANSFER_METHOD}`);
  }

  const facilitatorAddress = requirements.extra?.facilitatorAddress;
  if (facilitatorAddress !== undefined && typeof facilitatorAddress !== "string") {
    throw new Error("facilitatorAddress must be a string when provided");
  }

  const rawFee = requirements.extra?.facilitatorFee ?? 0;
  if (typeof rawFee !== "number" || !Number.isInteger(rawFee)) {
    throw new Error("facilitatorFee must be an integer number of basis points");
  }
  if (rawFee < 0 || rawFee > BASIS_POINTS_DENOMINATOR) {
    throw new Error("facilitatorFee must be between 0 and 10000 basis points");
  }
  if (!facilitatorAddress && rawFee !== 0) {
    throw new Error("facilitatorFee must be 0 when facilitatorAddress is omitted");
  }

  const operator = facilitatorAddress ?? requirements.payTo;
  const splits =
    operator === requirements.payTo
      ? []
      : [{ bps: BASIS_POINTS_DENOMINATOR - rawFee, recipient: requirements.payTo }];

  return { facilitatorFee: rawFee, operator, splits };
}
