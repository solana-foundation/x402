/**
 * Exact SVM payload structure containing a base64 encoded Solana transaction
 */
export type ExactSvmPayloadV1 = {
  /**
   * Base64 encoded Solana transaction
   */
  transaction: string;
};

/**
 * Exact SVM payload V2 structure (currently same as V1, reserved for future extensions)
 */
export type ExactSvmPayloadV2 = ExactSvmPayloadV1;

/**
 * The settlement profile the `upto` SVM scheme uses. Only `payment-channel`
 * (the normative v1 backend) ships today; the `permit` profile is deferred.
 * See `specs/schemes/upto/scheme_upto_svm.md`.
 */
export const UPTO_PROFILE_PAYMENT_CHANNEL = "payment-channel";

/**
 * Client authorization for the `upto` SVM scheme, `payment-channel` profile.
 *
 * The client opens a payment channel whose `deposit` is the authorized ceiling,
 * with `authorizedSigner` set to the operator so the operator can settle the
 * actual metered amount with a single voucher. The client signs only the
 * `open` transaction (pull mode); the facilitator broadcasts it. The `from`,
 * `maxAmount`, `validAfter`, and `expiresAt` fields mirror the network-agnostic
 * `UptoPayload`; the channel fields are the SVM specialization.
 */
export type UptoSvmPayloadV2 = {
  /** Settlement profile (`payment-channel` in v1). */
  profile: typeof UPTO_PROFILE_PAYMENT_CHANNEL;
  /** Payer wallet (base58). */
  from: string;
  /** Signed ceiling (base units). MUST equal verification-phase `amount`. */
  maxAmount: string;
  /** Deadline (Unix seconds); signed into the on-chain voucher. */
  expiresAt: number;
  /** Activation time (Unix seconds). */
  validAfter: number;
  /** Unique per-authorization identifier. */
  nonce: string;
  /** Channel PDA (base58). */
  channelId: string;
  /** On-chain escrow ceiling (base units); MUST equal `maxAmount`. */
  deposit: string;
  /** Voucher signer — the operator/facilitator key (base58). */
  authorizedSigner: string;
  /** Base64 client-signed `open` transaction for the facilitator to broadcast (pull). */
  openTransaction: string;
};

/**
 * Type guard for {@link UptoSvmPayloadV2}.
 *
 * @param payload - The candidate payload (the scheme-specific `PaymentPayload.payload`)
 * @returns Whether `payload` has the `upto` payment-channel shape
 */
export function isUptoSvmPayload(payload: Record<string, unknown>): payload is UptoSvmPayloadV2 {
  return (
    payload.profile === UPTO_PROFILE_PAYMENT_CHANNEL &&
    typeof payload.from === "string" &&
    typeof payload.maxAmount === "string" &&
    typeof payload.deposit === "string" &&
    typeof payload.channelId === "string" &&
    typeof payload.authorizedSigner === "string" &&
    typeof payload.openTransaction === "string" &&
    typeof payload.expiresAt === "number" &&
    typeof payload.validAfter === "number" &&
    typeof payload.nonce === "string"
  );
}
