/**
 * Scheme-specific error reasons for `batch-settlement` on SVM. All are prefixed
 * `invalid_batch_settlement_svm_` per the spec's §10 error-code table.
 */

const PREFIX = "invalid_batch_settlement_svm_";

export const BatchError = {
  /** The payload payload type is not a recognized batch-settlement payload. */
  UNSUPPORTED_PAYLOAD: "unsupported_payload_type",
  /** A `voucher`/`refund` referenced a channel the server does not know. */
  CHANNEL_NOT_FOUND: `${PREFIX}channel_not_found`,
  /** The channel is finalized/tombstoned. */
  CHANNEL_CLOSED: `${PREFIX}channel_closed`,
  /** A forced close is pending — new service vouchers are refused. */
  CHANNEL_CLOSING: `${PREFIX}channel_closing`,
  /** Voucher cumulative is at or below the accepted watermark (non-monotonic). */
  CUMULATIVE_BELOW_ACCEPTED: `${PREFIX}cumulative_below_accepted`,
  /** Voucher cumulative exceeds the on-chain deposit. */
  CUMULATIVE_EXCEEDS_DEPOSIT: `${PREFIX}cumulative_exceeds_deposit`,
  /** Cumulative increment is below the configured `minVoucherDelta`. */
  CUMULATIVE_BELOW_MIN_DELTA: `${PREFIX}cumulative_below_min_delta`,
  /** Ed25519 voucher signature verification failed. */
  VOUCHER_SIGNATURE: `${PREFIX}voucher_signature`,
  /** Voucher `expiresAt` is in the past. */
  VOUCHER_EXPIRED: `${PREFIX}voucher_expired`,
  /** Voucher signer is not the channel's authorized signer. */
  AUTHORIZED_SIGNER_MISMATCH: `${PREFIX}authorized_signer_mismatch`,
  /** Recomputed channel PDA disagrees with the declared/decoded channel id. */
  CHANNEL_ID_MISMATCH: `${PREFIX}channel_id_mismatch`,
  /** The decoded `open` transaction disagrees with the challenge. */
  OPEN_TRANSACTION_INVALID: `${PREFIX}open_transaction_invalid`,
  /** Open deposit is below the HTTP-enforced minimum. */
  DEPOSIT_BELOW_MINIMUM: `${PREFIX}deposit_below_minimum`,
  /** Channel payee does not match the requirement `payTo`. */
  RECEIVER_MISMATCH: `${PREFIX}receiver_mismatch`,
  /** First/next cumulative does not cover the per-request price. */
  CUMULATIVE_BELOW_PER_REQUEST: `${PREFIX}cumulative_below_per_request`,
  /** On-chain settle failed. */
  SETTLE_FAILED: `${PREFIX}settle_failed`,
  /** On-chain distribute failed. */
  DISTRIBUTE_FAILED: `${PREFIX}distribute_failed`,
  /** Cooperative close requested with nothing to refund/settle. */
  REFUND_NO_BALANCE: `${PREFIX}refund_no_balance`,
  /** Co-signing / broadcasting the channel open failed. */
  CHANNEL_OPEN_FAILED: `${PREFIX}channel_open_failed`,
} as const;

export type BatchErrorReason = (typeof BatchError)[keyof typeof BatchError];
