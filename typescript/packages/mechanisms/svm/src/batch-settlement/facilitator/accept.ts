/**
 * Off-chain voucher acceptance — the hot path executed before serving each paid
 * request. Verifies the Ed25519 signature, monotonicity, deposit cap, expiry,
 * `minVoucherDelta`, and the per-request floor, then advances the stored
 * watermark atomically. No on-chain transaction. Mirrors the Rust
 * `core::session::accept_voucher`.
 */

import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { BatchError, type BatchErrorReason } from "../errors";
import { type ChannelState, type ChannelStore } from "./store";

/** Inputs to {@link acceptVoucher}. */
export interface AcceptVoucherArgs {
  /** Channel PDA (base58). */
  channelId: string;
  /** Cumulative authorized total carried by the voucher (base units). */
  cumulativeAmount: bigint;
  /** Voucher expiry (Unix seconds). */
  expiresAt: number;
  /** Base58 Ed25519 signature. */
  signatureBase58: string;
  /** Base58 voucher signer. */
  signer: string;
  /** Current time (Unix seconds). */
  now: number;
  /** Minimum cumulative increment (base units); 0/undefined to disable. */
  minVoucherDelta?: bigint | undefined;
  /** Per-request floor the increment must cover (base units); undefined to skip. */
  perRequest?: bigint | undefined;
  /**
   * Minimum seconds an accepted voucher must remain valid past {@link now}.
   * Set to the operator's settlement grace period: `settle`/`settleAndFinalize`
   * re-check `expires_at` on-chain after the async batch redemption, so a
   * voucher accepted now must outlast that settlement window. Ignored when a
   * voucher never expires (`expiresAt === 0`). 0/undefined to disable.
   */
  minExpiryWindowSeconds?: number | undefined;
}

/**
 * Result of {@link acceptVoucher}.
 *
 * On success, `replay === true` (with `charged === 0n`) marks an idempotent
 * retry of an already-served request: the voucher is byte-for-byte the current
 * watermark (same `cumulativeAmount` AND same `signatureBase58`). The
 * `cumulativeAmount` is the per-request nonce, so a genuinely new request always
 * carries a strictly higher cumulative. On a replay the server MUST return the
 * response previously cached by `(channelId, cumulativeAmount)` and MUST NOT
 * serve a fresh resource. `replay === false` (with `charged === delta`) marks a
 * new charge that advanced the watermark.
 */
export type AcceptResult =
  | { ok: true; charged: bigint; replay: boolean; state: ChannelState }
  | { ok: false; reason: BatchErrorReason };

/** Internal typed rejection carrying a scheme error reason. */
class Rejection extends Error {
  /**
   * Construct a rejection.
   *
   * @param reason - The scheme error reason
   */
  constructor(readonly reason: BatchErrorReason) {
    super(reason);
  }
}

/**
 * Verify and accept a cumulative voucher, advancing the channel watermark.
 *
 * All validation runs inside the store's per-channel atomic update, so
 * concurrent acceptance for the same channel is serialized and the watermark
 * can never regress. An exact replay of the current watermark (same cumulative
 * + same signature) is accepted as a no-op (`charged = 0`, `replay = true`); see
 * {@link AcceptResult} — on a replay the server MUST re-serve the response
 * cached by `(channelId, cumulativeAmount)` and MUST NOT serve a fresh resource.
 *
 * @param store - The channel store
 * @param args - Voucher acceptance inputs
 * @returns Whether the voucher was accepted, the charge, and the new state
 */
export async function acceptVoucher(
  store: ChannelStore,
  args: AcceptVoucherArgs,
): Promise<AcceptResult> {
  let charged = 0n;
  let replay = false;
  try {
    const state = await store.update(args.channelId, async current => {
      if (!current) throw new Rejection(BatchError.CHANNEL_NOT_FOUND);
      if (current.status === "finalized") throw new Rejection(BatchError.CHANNEL_CLOSED);
      if (current.status === "closing" || current.closeRequestedAt !== undefined) {
        throw new Rejection(BatchError.CHANNEL_CLOSING);
      }
      if (args.signer !== current.authorizedSigner) {
        throw new Rejection(BatchError.AUTHORIZED_SIGNER_MISMATCH);
      }
      // `expiresAt === 0` means never-expires (the program and the settle path
      // treat 0 as no-expiry), so skip the window checks. Otherwise reject a
      // past expiry, and — when a settlement window is configured — reject a
      // voucher that would expire before the operator can batch-redeem it,
      // since settle/settleAndFinalize re-check expires_at on-chain afterward.
      if (args.expiresAt !== 0) {
        if (args.expiresAt <= args.now) throw new Rejection(BatchError.VOUCHER_EXPIRED);
        if (
          args.minExpiryWindowSeconds !== undefined &&
          args.minExpiryWindowSeconds > 0 &&
          args.expiresAt < args.now + args.minExpiryWindowSeconds
        ) {
          throw new Rejection(BatchError.VOUCHER_EXPIRES_BEFORE_SETTLEMENT);
        }
      }

      // Idempotent replay: identical cumulative + signature is a no-op re-serve.
      if (
        args.cumulativeAmount === current.cumulative &&
        args.signatureBase58 === current.highestVoucherSignature
      ) {
        if (!(await verifyVoucherSig(args))) throw new Rejection(BatchError.VOUCHER_SIGNATURE);
        charged = 0n;
        replay = true;
        return current;
      }

      if (args.cumulativeAmount <= current.cumulative) {
        throw new Rejection(BatchError.CUMULATIVE_BELOW_ACCEPTED);
      }
      if (args.cumulativeAmount > current.deposit) {
        throw new Rejection(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
      }
      const delta = args.cumulativeAmount - current.cumulative;
      if (args.minVoucherDelta && args.minVoucherDelta > 0n && delta < args.minVoucherDelta) {
        throw new Rejection(BatchError.CUMULATIVE_BELOW_MIN_DELTA);
      }
      if (args.perRequest !== undefined && delta < args.perRequest) {
        throw new Rejection(BatchError.CUMULATIVE_BELOW_PER_REQUEST);
      }
      if (!(await verifyVoucherSig(args))) throw new Rejection(BatchError.VOUCHER_SIGNATURE);

      charged = delta;
      return {
        ...current,
        cumulative: args.cumulativeAmount,
        highestVoucherExpiresAt: args.expiresAt,
        highestVoucherSignature: args.signatureBase58,
      };
    });
    return { charged, ok: true, replay, state };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, reason: error.reason };
    throw error;
  }
}

/**
 * Verify the Ed25519 signature over the canonical 48-byte voucher message.
 *
 * @param args - Voucher fields
 * @returns Whether the signature is valid
 */
function verifyVoucherSig(args: AcceptVoucherArgs): Promise<boolean> {
  return verifyVoucherSignature({
    message: encodeVoucherMessageBytes({
      channelId: args.channelId,
      cumulativeAmount: args.cumulativeAmount,
      expiresAt: BigInt(args.expiresAt),
    }),
    signatureBase58: args.signatureBase58,
    signerBase58: args.signer,
  });
}
