/**
 * Client-side channel helpers for `batch-settlement`: signing cumulative
 * vouchers and building the `deposit` (channel open + first voucher) payload.
 *
 * The client is the channel's `authorizedSigner` (the session / client-voucher
 * model), so it signs every cumulative voucher itself. Reuses the shared
 * payment-channels open builder and 48-byte voucher encoding.
 */

import {
  createSignableMessage,
  getBase58Decoder,
  type MessagePartialSigner,
  type TransactionSigner,
} from "@solana/kit";

import { buildOpenPaymentChannelTransaction, type ChannelSplit } from "../../payment-channels/open";
import { encodeVoucherMessageBytes } from "../../payment-channels/voucher";
import { type BatchDepositPayload, type BatchSplit, type BatchVoucher } from "../types";

/** A client signer able to sign both transactions and raw voucher messages. */
export type BatchClientSigner = TransactionSigner & MessagePartialSigner;

/**
 * Sign a cumulative voucher and return its wire form.
 *
 * @param signer - The channel's authorized signer (the client)
 * @param voucher - The voucher fields
 * @param voucher.channelId - Channel PDA (base58)
 * @param voucher.cumulativeAmount - Cumulative authorized total (base units)
 * @param voucher.expiresAt - Voucher expiry (Unix seconds)
 * @returns The signed {@link BatchVoucher}
 */
export async function signBatchVoucher(
  signer: BatchClientSigner,
  voucher: { channelId: string; cumulativeAmount: bigint; expiresAt: number },
): Promise<BatchVoucher> {
  const message = encodeVoucherMessageBytes({
    channelId: voucher.channelId,
    cumulativeAmount: voucher.cumulativeAmount,
    expiresAt: BigInt(voucher.expiresAt),
  });
  const [dict] = await signer.signMessages([createSignableMessage(message)]);
  const signature = dict[signer.address];
  if (!signature) throw new Error("client did not return a voucher signature");
  return {
    channelId: voucher.channelId,
    cumulativeAmount: voucher.cumulativeAmount.toString(),
    expiresAt: voucher.expiresAt,
    signature: getBase58Decoder().decode(signature as Uint8Array),
    signer: signer.address,
  };
}

/**
 * A per-channel cumulative tracker. Holds the running cumulative total and
 * issues monotonically increasing vouchers — one per paid request.
 */
export class BatchChannelTracker {
  private cumulativeAmount: bigint;

  /**
   * Create a cumulative voucher tracker for a channel.
   *
   * @param channelId - Channel PDA (base58)
   * @param signer - The channel's authorized signer (the client)
   * @param expiresAt - Voucher expiry (Unix seconds) applied to issued vouchers
   * @param initialCumulative - Cumulative already authorized (default 0)
   */
  constructor(
    readonly channelId: string,
    private readonly signer: BatchClientSigner,
    private expiresAt: number,
    initialCumulative: bigint = 0n,
  ) {
    this.cumulativeAmount = initialCumulative;
  }

  /**
   * The cumulative total authorized so far (base units).
   *
   * @returns The current cumulative amount
   */
  get cumulative(): bigint {
    return this.cumulativeAmount;
  }

  /**
   * Advance the cumulative by `charge` and sign the next voucher.
   *
   * @param charge - The per-request charge to add (base units)
   * @param expiresAt - Optional new expiry (Unix seconds) for this and later vouchers
   * @returns The signed voucher
   */
  async voucher(charge: bigint, expiresAt?: number): Promise<BatchVoucher> {
    if (charge <= 0n) throw new Error("charge must be positive");
    if (expiresAt !== undefined) this.expiresAt = expiresAt;
    this.cumulativeAmount += charge;
    return signBatchVoucher(this.signer, {
      channelId: this.channelId,
      cumulativeAmount: this.cumulativeAmount,
      expiresAt: this.expiresAt,
    });
  }
}

/** Inputs to {@link buildDepositPayload}. */
export interface BuildDepositArgs {
  /** The payer / client signer (also the channel authorized signer). */
  payer: BatchClientSigner;
  /** Channel proceeds recipient (base58). */
  payee: string;
  /** SPL mint (base58). */
  mint: string;
  /** Operator key (fee payer + open co-signer), from `extra.feePayer`. */
  feePayer: string;
  /** Token program id for the mint. */
  tokenProgram: string;
  /** Recent blockhash for the open transaction lifetime. */
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  /** Escrow deposit (base units). */
  depositAmount: bigint;
  /** First per-request charge to authorize (base units); omit for a deposit with no voucher. */
  firstCharge?: bigint | undefined;
  /** Voucher expiry (Unix seconds) for the first voucher. */
  expiresAt: number;
  /** Forced-close grace period (seconds). */
  gracePeriodSeconds?: number | undefined;
  /** Channel program id override. */
  programId?: string | undefined;
  /** Distribution splits sealed into the channel at open. */
  distributionSplits?: BatchSplit[] | undefined;
}

/** Result of {@link buildDepositPayload}. */
export interface BuiltDeposit {
  /** Channel PDA (base58). */
  channelId: string;
  /** The `deposit` payload to send. */
  payload: BatchDepositPayload;
  /** A tracker primed with the first voucher's cumulative, for steady-state requests. */
  tracker: BatchChannelTracker;
}

/**
 * Build a `deposit` payload: a client-signed channel `open` (with the client as
 * authorized signer) plus an optional first cumulative voucher.
 *
 * @param args - Deposit inputs
 * @returns The channel id, the `deposit` payload, and a primed tracker
 */
export async function buildDepositPayload(args: BuildDepositArgs): Promise<BuiltDeposit> {
  const recipients: ChannelSplit[] | undefined = args.distributionSplits?.map(s => ({
    bps: s.shareBps,
    recipient: s.recipient,
  }));

  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner: args.payer.address,
    blockhash: args.blockhash,
    deposit: args.depositAmount,
    mint: args.mint,
    operator: args.feePayer,
    payee: args.payee,
    payer: args.payer,
    programId: args.programId,
    ...(args.gracePeriodSeconds !== undefined ? { gracePeriod: args.gracePeriodSeconds } : {}),
    ...(recipients ? { recipients } : {}),
    tokenProgram: args.tokenProgram,
  });

  const tracker = new BatchChannelTracker(open.channelId, args.payer, args.expiresAt);
  let voucher: BatchVoucher | undefined;
  if (args.firstCharge !== undefined && args.firstCharge > 0n) {
    voucher = await tracker.voucher(args.firstCharge);
  }

  const channelConfig: BatchChannelConfigInternal = {
    authorizedSigner: args.payer.address,
    depositAmount: args.depositAmount.toString(),
    gracePeriodSeconds: args.gracePeriodSeconds ?? 0,
    mint: args.mint,
    payee: args.payee,
    payer: args.payer.address,
    salt: open.salt.toString(),
    ...(args.distributionSplits ? { distributionSplits: args.distributionSplits } : {}),
  };

  return {
    channelId: open.channelId,
    payload: {
      channelConfig,
      transaction: open.transaction,
      type: "deposit",
      ...(voucher ? { voucher } : {}),
    },
    tracker,
  };
}

/** Local alias so the builder reads cleanly without re-importing the wire type. */
type BatchChannelConfigInternal = BatchDepositPayload["channelConfig"];
