/**
 * Wire types for the SVM `batch-settlement` payment scheme.
 *
 * `batch-settlement` is the multi-voucher generalization of `upto`: the client
 * deposits once into a long-lived payment channel, then signs a stream of
 * cumulative Ed25519 vouchers (one per request) that the server verifies
 * off-chain and the operator redeems on-chain later, in batches. The channel
 * PDA, 48-byte voucher layout, and on-chain program are shared with `upto`.
 *
 * See `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md`.
 */

/** Scheme discriminator value. */
export const BATCH_SETTLEMENT_SCHEME = "batch-settlement";

/** The only normative profile in v1 (on-chain payment-channels backend). */
export const BATCH_PROFILE_PAYMENT_CHANNEL = "payment-channel";

/** A merchant-side distribution split, committed into the channel at open. */
export type BatchSplit = {
  /** Recipient address (base58). */
  recipient: string;
  /** Share in basis points (10000 = 100%). */
  shareBps: number;
};

/**
 * Facilitator/server metadata folded into `PaymentRequirements.extra` for the
 * `batch-settlement` scheme.
 */
export type BatchExtra = {
  /** Supported profiles in server preference order (subset of `["payment-channel"]`). */
  profiles: string[];
  /** Channel program id (base58). */
  channelProgram: string;
  /** Forced-close grace period (seconds); non-zero. */
  gracePeriodSeconds: number;
  /** Operator key that sponsors fees (co-signs/broadcasts `open`) and submits settlement (base58). */
  feePayer: string;
  /** Token decimals. */
  decimals?: number | undefined;
  /** Token program id (`Tokenkeg…` or `TokenzQ…`). */
  tokenProgram?: string | undefined;
  /** Pre-fetched blockhash so the client can build `open`/`topUp` without an RPC. */
  recentBlockhash?: string | undefined;
  /** Suggested initial deposit (base units). */
  suggestedDeposit?: string | undefined;
  /** HTTP-enforced minimum initial deposit (base units). */
  minimumDeposit?: string | undefined;
  /** Minimum cumulative increment between accepted vouchers (base units). */
  minVoucherDelta?: string | undefined;
  /** Merchant-side splits committed at open; payee gets the remainder. */
  distributionSplits?: BatchSplit[] | undefined;
};

/**
 * A cumulative payment-channel voucher. The signed message is the canonical
 * 48-byte payload `channelId ‖ cumulativeAmount(u64 le) ‖ expiresAt(i64 le)` —
 * identical to `upto` and the MPP `session` voucher.
 */
export type BatchVoucher = {
  /** Channel PDA (base58). */
  channelId: string;
  /** Cumulative authorized total (base units); monotonically increasing. */
  cumulativeAmount: string;
  /** Voucher expiry (Unix seconds); MUST be a future time. */
  expiresAt: number;
  /** Base58 voucher signer = the channel's `authorizedSigner` (the client). */
  signer: string;
  /** Base58 Ed25519 signature over the 48-byte voucher payload. */
  signature: string;
};

/** Channel-open parameters carried in a {@link BatchDepositPayload}. */
export type BatchChannelConfig = {
  /** Deposit signer / channel payer (base58). */
  payer: string;
  /** Channel proceeds recipient (base58). */
  payee: string;
  /** SPL mint (base58). */
  mint: string;
  /** Voucher signer (base58) — the client, in the v1 client-voucher model. */
  authorizedSigner: string;
  /** PDA disambiguator (u64 as decimal string). */
  salt: string;
  /** Escrow deposit (base units). */
  depositAmount: string;
  /** Forced-close grace period (seconds). */
  gracePeriodSeconds: number;
  /** Distribution splits sealed into the channel. */
  distributionSplits?: BatchSplit[] | undefined;
};

/** Open (or top up) a channel and authorize the first voucher. */
export type BatchDepositPayload = {
  type: "deposit";
  channelConfig: BatchChannelConfig;
  /** Base64 client-signed `open`/`topUp` transaction for the operator to co-sign + broadcast. */
  transaction: string;
  /** First cumulative voucher (omitted on a pure top-up). */
  voucher?: BatchVoucher | undefined;
};

/** Steady-state paid request (off-chain only, no transaction). */
export type BatchVoucherPayload = {
  type: "voucher";
  channelId: string;
  voucher: BatchVoucher;
};

/** Cooperative close (the application route is bypassed). */
export type BatchRefundPayload = {
  type: "refund";
  channelId: string;
  /** Optional final voucher to settle before refunding. */
  voucher?: BatchVoucher | undefined;
};

/** Discriminated union carried in `PaymentPayload.payload`. */
export type BatchPayload = BatchDepositPayload | BatchVoucherPayload | BatchRefundPayload;

/** On-chain channel status surfaced in a settlement response. */
export type BatchChannelStatus = "open" | "closing" | "finalized";

/** Channel snapshot returned in the settlement response. */
export type BatchChannelSnapshot = {
  channelId: string;
  /** Escrow deposit (base units). */
  deposit: string;
  /** Cumulative settled watermark (base units). */
  settled: string;
  /** Cumulative distributed (base units). */
  paidOut: string;
  status: BatchChannelStatus;
};

/**
 * Type guard for a {@link BatchVoucher}.
 *
 * @param value - The candidate value
 * @returns Whether `value` has the voucher shape
 */
export function isBatchVoucher(value: unknown): value is BatchVoucher {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.channelId === "string" &&
    typeof v.cumulativeAmount === "string" &&
    typeof v.expiresAt === "number" &&
    typeof v.signer === "string" &&
    typeof v.signature === "string"
  );
}

/**
 * Type guard for a {@link BatchPayload} (the scheme-specific `PaymentPayload.payload`).
 *
 * @param value - The candidate value
 * @returns Whether `value` is a recognized batch-settlement payload
 */
export function isBatchPayload(value: unknown): value is BatchPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Record<string, unknown>;
  switch (payload.type) {
    case "deposit":
      return (
        typeof payload.transaction === "string" &&
        typeof payload.channelConfig === "object" &&
        payload.channelConfig !== null &&
        (payload.voucher === undefined || isBatchVoucher(payload.voucher))
      );
    case "voucher":
      return typeof payload.channelId === "string" && isBatchVoucher(payload.voucher);
    case "refund":
      return (
        typeof payload.channelId === "string" &&
        (payload.voucher === undefined || isBatchVoucher(payload.voucher))
      );
    default:
      return false;
  }
}
