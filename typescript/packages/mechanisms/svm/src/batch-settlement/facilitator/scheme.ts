import { type Address, address } from "@solana/kit";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import {
  buildDistributeInstruction,
  buildSettleAndFinalizeInstructions,
  buildSettleInstructions,
  PAYMENT_CHANNELS_PROGRAM_ID,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import {
  findPaymentChannelPda,
  parseU64,
  verifyOpenTransaction,
} from "../../payment-channels/open";
import {
  broadcastOpen,
  channelExists,
  type OperatorSigner,
  submitSettle,
} from "../../upto/facilitator/channel";
import { createRpcClient, getStablecoinTokenProgram } from "../../utils";
import { BatchError } from "../errors";
import {
  BATCH_PROFILE_PAYMENT_CHANNEL,
  BATCH_SETTLEMENT_SCHEME,
  type BatchChannelSnapshot,
  type BatchPayload,
  type BatchVoucher,
  isBatchPayload,
} from "../types";
import { acceptVoucher } from "./accept";
import { type ChannelState, type ChannelStore, MemoryChannelStore } from "./store";

/** Default forced-close grace period (seconds). */
const DEFAULT_GRACE_PERIOD_SECONDS = 900;

/** Max channels packed into a single `settle` transaction (tx-size-bounded). */
export const MAX_CHANNELS_PER_SETTLE_TX = 3;

/** Optional configuration for the batch-settlement SVM facilitator. */
export interface BatchSvmFacilitatorConfig {
  /** Custom RPC URL (per-network defaults are used when omitted). */
  rpcUrl?: string;
  /** Channel program id override (base58). */
  programId?: string;
  /** Forced-close grace period advertised to clients (seconds; default 900). */
  gracePeriodSeconds?: number;
  /** Minimum cumulative increment between accepted vouchers (base units). */
  minVoucherDelta?: string;
  /** Suggested initial deposit advertised to clients (base units). */
  suggestedDeposit?: string;
  /** HTTP-enforced minimum initial deposit (base units). */
  minimumDeposit?: string;
  /** Token program hint (base58); resolved from the stablecoin table otherwise. */
  tokenProgram?: string;
  /** Durable channel store; an in-memory store is used when omitted. */
  store?: ChannelStore;
}

/**
 * SVM facilitator for the `batch-settlement` payment scheme.
 *
 * Stateful: it holds a {@link ChannelStore} of per-channel watermarks. `verify`
 * does the off-chain work that gates serving — for a `deposit` it validates and
 * broadcasts the channel `open` and accepts the first voucher; for a `voucher`
 * it accepts the cumulative voucher off-chain; for a `refund` it freezes the
 * channel. `settle` reports the off-chain charge (no transaction) for vouchers,
 * the open signature for deposits, and runs settle_and_finalize + distribute for
 * refunds. The batched on-chain redemption ({@link settleBatch} / {@link
 * distribute}) is operator-driven and runs out of band, not in the request path.
 *
 * The client is the channel's `authorizedSigner` and signs every voucher; the
 * operator only ever co-signs the open and submits settlement, so it can never
 * exceed the on-chain deposit or redirect funds from the fixed payee.
 */
export class BatchSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "solana:*";
  private readonly store: ChannelStore;

  /**
   * Create the batch-settlement SVM facilitator.
   *
   * @param operator - The operator signer: open fee payer/co-signer and settlement submitter
   * @param config - Optional configuration
   */
  constructor(
    private readonly operator: OperatorSigner,
    private readonly config: BatchSvmFacilitatorConfig = {},
  ) {
    this.store = config.store ?? new MemoryChannelStore();
  }

  /**
   * Advertise the operator, channel program, grace period, and optional channel
   * economics into the requirement's `extra`.
   *
   * @param _ - The network identifier (unused)
   * @returns Extra metadata folded into the requirement's `extra`
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    const extra: Record<string, unknown> = {
      channelProgram: this.programId(),
      feePayer: this.operator.address,
      gracePeriodSeconds: this.config.gracePeriodSeconds ?? DEFAULT_GRACE_PERIOD_SECONDS,
      profiles: [BATCH_PROFILE_PAYMENT_CHANNEL],
    };
    if (this.config.minVoucherDelta !== undefined)
      extra.minVoucherDelta = this.config.minVoucherDelta;
    if (this.config.suggestedDeposit !== undefined)
      extra.suggestedDeposit = this.config.suggestedDeposit;
    if (this.config.minimumDeposit !== undefined) extra.minimumDeposit = this.config.minimumDeposit;
    if (this.config.tokenProgram !== undefined) extra.tokenProgram = this.config.tokenProgram;
    return extra;
  }

  /**
   * The operator signer addresses.
   *
   * @param _ - The network identifier (unused)
   * @returns The operator address
   */
  getSigners(_: string): string[] {
    return [this.operator.address];
  }

  /**
   * Validate the payload and perform the off-chain work that gates serving.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (`amount` = per-request price)
   * @returns The verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isBatchPayload(raw)) {
      return { isValid: false, invalidReason: BatchError.UNSUPPORTED_PAYLOAD, payer: "" };
    }
    if (
      payload.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return { isValid: false, invalidReason: "unsupported_scheme", payer: "" };
    }
    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch", payer: "" };
    }
    if (requirements.extra?.feePayer !== this.operator.address) {
      return { isValid: false, invalidReason: "facilitator_mismatch", payer: "" };
    }

    const p = raw as BatchPayload;
    switch (p.type) {
      case "deposit":
        return this.verifyDeposit(p, requirements);
      case "voucher":
        return this.verifyVoucher(p, requirements);
      case "refund":
        return this.verifyRefund(p, requirements);
    }
  }

  /**
   * Report the settlement outcome for an already-verified payload.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @returns The settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const raw = payload.payload as Record<string, unknown>;
    const network = payload.accepted.network;
    if (!isBatchPayload(raw)) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: BatchError.UNSUPPORTED_PAYLOAD,
        payer: "",
      };
    }
    const p = raw as BatchPayload;
    try {
      switch (p.type) {
        case "voucher":
          return await this.settleVoucher(p, requirements, network);
        case "deposit":
          return await this.settleDeposit(p, requirements, network);
        case "refund":
          return await this.settleRefund(p, requirements, network);
      }
    } catch (error) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: "transaction_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: "",
      };
    }
  }

  // ── operator-driven, out-of-band redemption ───────────────────────

  /**
   * Redeem the latest accepted voucher for each channel whose off-chain
   * watermark is ahead of its on-chain `settled`, packing channels into
   * `settle` transactions (≤ {@link MAX_CHANNELS_PER_SETTLE_TX} each). No token
   * movement — only advances the on-chain settled watermark. Channels with no
   * voucher, nothing new to settle, or an expired voucher are skipped.
   *
   * @param channelIds - Channels to consider
   * @param network - The CAIP-2 network
   * @returns Submitted transaction signatures
   */
  async settleBatch(channelIds: string[], network: Network): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000);
    const pending: { channelId: string; cumulative: bigint; ixs: ServerInstruction[] }[] = [];
    for (const channelId of channelIds) {
      const state = await this.store.get(channelId);
      if (!state) continue;
      const voucher = this.highestVoucher(state);
      if (!voucher || state.cumulative <= state.settled) continue;
      if (voucher.expiresAt !== 0n && voucher.expiresAt <= BigInt(now)) continue;
      pending.push({
        channelId,
        cumulative: state.cumulative,
        ixs: buildSettleInstructions({
          channelId: state.channelId,
          programId: this.maybeProgramId(state.programId),
          voucher,
        }),
      });
    }

    const rpc = createRpcClient(network, this.config.rpcUrl);
    const signatures: string[] = [];
    for (let i = 0; i < pending.length; i += MAX_CHANNELS_PER_SETTLE_TX) {
      const group = pending.slice(i, i + MAX_CHANNELS_PER_SETTLE_TX);
      const signature = await submitSettle(
        this.operator,
        rpc,
        group.flatMap(g => g.ixs),
      );
      signatures.push(signature);
      for (const g of group) {
        await this.store.update(g.channelId, current => {
          if (!current) throw new Error("channel disappeared");
          return { ...current, settled: g.cumulative };
        });
      }
    }
    return signatures;
  }

  /**
   * Sweep settled-but-undistributed funds for a channel to payee/splits/treasury.
   *
   * @param channelId - Channel PDA (base58)
   * @param network - The CAIP-2 network
   * @returns The distribute signature, or null if nothing to sweep
   */
  async distribute(channelId: string, network: Network): Promise<string | null> {
    const state = await this.store.get(channelId);
    if (!state || state.settled <= state.paidOut) return null;
    const rpc = createRpcClient(network, this.config.rpcUrl);
    const instruction = await buildDistributeInstruction({
      channelId: state.channelId,
      mint: state.mint,
      payee: state.payee,
      payer: state.payer,
      programId: this.maybeProgramId(state.programId),
      rentPayer: this.operator.address,
      splits: state.splits.map(s => ({ bps: s.shareBps, recipient: s.recipient })),
      tokenProgram: state.tokenProgram,
    });
    const signature = await submitSettle(this.operator, rpc, [instruction]);
    await this.store.update(channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return { ...current, paidOut: current.settled };
    });
    return signature;
  }

  // ── verify branches ───────────────────────────────────────────────

  /**
   * Validate + broadcast the channel open, persist state, accept the first voucher.
   *
   * @param p - The deposit payload
   * @param requirements - The payment requirements
   * @returns The verification response
   */
  private async verifyDeposit(
    p: Extract<BatchPayload, { type: "deposit" }>,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const cfg = p.channelConfig;
    const programId =
      (requirements.extra?.channelProgram as string | undefined) ?? this.config.programId;

    let open: Awaited<ReturnType<typeof verifyOpenTransaction>>;
    try {
      open = await verifyOpenTransaction(p.transaction, {
        authorizedSigner: cfg.authorizedSigner,
        maxCap: parseU64(cfg.depositAmount, "depositAmount"),
        mint: requirements.asset,
        operator: this.operator.address,
        payee: requirements.payTo,
        programId,
      });
    } catch (error) {
      return {
        isValid: false,
        invalidReason: BatchError.OPEN_TRANSACTION_INVALID,
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: cfg.payer,
      };
    }

    if (open.payer !== cfg.payer) {
      return {
        isValid: false,
        invalidReason: BatchError.OPEN_TRANSACTION_INVALID,
        invalidMessage: `open payer ${open.payer} != channelConfig.payer ${cfg.payer}`,
        payer: cfg.payer,
      };
    }

    // Bind the declared channel id to the recomputed PDA.
    const expectedPda = await findPaymentChannelPda({
      authorizedSigner: cfg.authorizedSigner,
      mint: cfg.mint,
      payee: cfg.payee,
      payer: cfg.payer,
      programId,
      salt: parseU64(cfg.salt, "salt"),
    });
    if (expectedPda !== open.channelId) {
      return { isValid: false, invalidReason: BatchError.CHANNEL_ID_MISMATCH, payer: cfg.payer };
    }

    const minimum = requirements.extra?.minimumDeposit as string | undefined;
    if (minimum !== undefined && open.deposit < parseU64(minimum, "minimumDeposit")) {
      return { isValid: false, invalidReason: BatchError.DEPOSIT_BELOW_MINIMUM, payer: cfg.payer };
    }

    // Escrow the deposit before serving: broadcast the open (idempotent).
    let openSignature: string | undefined;
    try {
      const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
      if (!(await channelExists(rpc, open.channelId))) {
        openSignature = await broadcastOpen(this.operator, rpc, p.transaction);
      }
    } catch (error) {
      return {
        isValid: false,
        invalidReason: BatchError.CHANNEL_OPEN_FAILED,
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: cfg.payer,
      };
    }

    const tokenProgram =
      (requirements.extra?.tokenProgram as string | undefined) ??
      this.config.tokenProgram ??
      getStablecoinTokenProgram(requirements.asset, requirements.network);

    const state: ChannelState = {
      authorizedSigner: cfg.authorizedSigner,
      channelId: open.channelId,
      cumulative: 0n,
      deposit: open.deposit,
      mint: requirements.asset,
      openSignature,
      paidOut: 0n,
      payee: requirements.payTo,
      payer: open.payer,
      programId,
      settled: 0n,
      splits: cfg.distributionSplits ?? [],
      status: "open",
      tokenProgram,
    };
    await this.store.put(state);

    if (p.voucher) {
      const accepted = await this.accept(p.voucher, requirements);
      if (!accepted.ok) {
        return { isValid: false, invalidReason: accepted.reason, payer: cfg.payer };
      }
      return { isValid: true, payer: cfg.payer, extra: { channelState: snapshot(accepted.state) } };
    }
    return { isValid: true, payer: cfg.payer, extra: { channelState: snapshot(state) } };
  }

  /**
   * Accept a steady-state voucher off-chain.
   *
   * @param p - The voucher payload
   * @param requirements - The payment requirements
   * @returns The verification response
   */
  private async verifyVoucher(
    p: Extract<BatchPayload, { type: "voucher" }>,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const state = await this.store.get(p.channelId);
    if (!state) return { isValid: false, invalidReason: BatchError.CHANNEL_NOT_FOUND, payer: "" };
    if (p.voucher.channelId !== p.channelId) {
      return { isValid: false, invalidReason: BatchError.CHANNEL_ID_MISMATCH, payer: state.payer };
    }
    const accepted = await this.accept(p.voucher, requirements);
    if (!accepted.ok) {
      return { isValid: false, invalidReason: accepted.reason, payer: state.payer };
    }
    return {
      isValid: true,
      payer: state.payer,
      extra: { channelState: snapshot(accepted.state), chargedAmount: accepted.charged.toString() },
    };
  }

  /**
   * Freeze a channel for cooperative close (proof-of-ownership voucher required).
   *
   * @param p - The refund payload
   * @param requirements - The payment requirements
   * @returns The verification response
   */
  private async verifyRefund(
    p: Extract<BatchPayload, { type: "refund" }>,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const state = await this.store.get(p.channelId);
    if (!state) return { isValid: false, invalidReason: BatchError.CHANNEL_NOT_FOUND, payer: "" };

    // A final voucher, when present and advancing, is accepted before freezing.
    if (p.voucher) {
      if (p.voucher.channelId !== p.channelId) {
        return {
          isValid: false,
          invalidReason: BatchError.CHANNEL_ID_MISMATCH,
          payer: state.payer,
        };
      }
      if (BigInt(p.voucher.cumulativeAmount) > state.cumulative) {
        const accepted = await this.accept(p.voucher, { ...requirements, amount: "0" });
        if (!accepted.ok)
          return { isValid: false, invalidReason: accepted.reason, payer: state.payer };
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const frozen = await this.store.update(p.channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return { ...current, closeRequestedAt: now, status: "closing" };
    });
    return { isValid: true, payer: state.payer, extra: { channelState: snapshot(frozen) } };
  }

  // ── settle branches ───────────────────────────────────────────────

  /**
   * Off-chain voucher acceptance produces no transaction — report the charge.
   *
   * @param p - The voucher payload
   * @param requirements - The payment requirements
   * @param network - The CAIP-2 network
   * @returns The settlement response
   */
  private async settleVoucher(
    p: Extract<BatchPayload, { type: "voucher" }>,
    requirements: PaymentRequirements,
    network: Network,
  ): Promise<SettleResponse> {
    const state = await this.store.get(p.channelId);
    if (!state) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: BatchError.CHANNEL_NOT_FOUND,
        payer: "",
      };
    }
    return {
      success: true,
      network,
      transaction: "",
      amount: "",
      payer: state.payer,
      extra: { chargedAmount: requirements.amount, channelState: snapshot(state) },
    };
  }

  /**
   * The deposit's open was broadcast during verify — report its signature.
   *
   * @param p - The deposit payload
   * @param _ - The payment requirements (unused)
   * @param network - The CAIP-2 network
   * @returns The settlement response
   */
  private async settleDeposit(
    p: Extract<BatchPayload, { type: "deposit" }>,
    _: PaymentRequirements,
    network: Network,
  ): Promise<SettleResponse> {
    const cfg = p.channelConfig;
    const channelId = await findPaymentChannelPda({
      authorizedSigner: cfg.authorizedSigner,
      mint: cfg.mint,
      payee: cfg.payee,
      payer: cfg.payer,
      programId: this.config.programId,
      salt: parseU64(cfg.salt, "salt"),
    });
    const state = await this.store.get(channelId);
    if (!state) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: BatchError.CHANNEL_NOT_FOUND,
        payer: cfg.payer,
      };
    }
    return {
      success: true,
      network,
      transaction: state.openSignature ?? "",
      amount: state.deposit.toString(),
      payer: state.payer,
      extra: { channelState: snapshot(state) },
    };
  }

  /**
   * Cooperative close: settle_and_finalize the latest voucher + distribute.
   *
   * @param p - The refund payload
   * @param requirements - The payment requirements
   * @param network - The CAIP-2 network
   * @returns The settlement response
   */
  private async settleRefund(
    p: Extract<BatchPayload, { type: "refund" }>,
    requirements: PaymentRequirements,
    network: Network,
  ): Promise<SettleResponse> {
    const state = await this.store.get(p.channelId);
    if (!state) {
      return {
        success: false,
        network,
        transaction: "",
        errorReason: BatchError.CHANNEL_NOT_FOUND,
        payer: "",
      };
    }
    const programId = this.maybeProgramId(state.programId);
    const instructions: ServerInstruction[] = buildSettleAndFinalizeInstructions({
      channelId: state.channelId,
      merchantSigner: this.operator,
      programId,
      voucher: this.highestVoucher(state),
    });
    if (state.cumulative > 0n) {
      instructions.push(
        await buildDistributeInstruction({
          channelId: state.channelId,
          mint: state.mint,
          payee: state.payee,
          payer: state.payer,
          programId,
          rentPayer: this.operator.address,
          splits: state.splits.map(s => ({ bps: s.shareBps, recipient: s.recipient })),
          tokenProgram: state.tokenProgram,
        }),
      );
    }

    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const signature = await submitSettle(this.operator, rpc, instructions);
    const finalized = await this.store.update(state.channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return {
        ...current,
        paidOut: current.cumulative,
        settled: current.cumulative,
        status: "finalized",
      };
    });
    return {
      success: true,
      network,
      transaction: signature,
      amount: state.cumulative.toString(),
      payer: state.payer,
      extra: { channelState: snapshot(finalized) },
    };
  }

  // ── internals ─────────────────────────────────────────────────────

  /**
   * Accept a wire voucher into the store.
   *
   * @param voucher - The wire voucher
   * @param requirements - The payment requirements (`amount` = per-request floor)
   * @returns The acceptance result
   */
  private accept(voucher: BatchVoucher, requirements: PaymentRequirements) {
    return acceptVoucher(this.store, {
      channelId: voucher.channelId,
      cumulativeAmount: BigInt(voucher.cumulativeAmount),
      expiresAt: voucher.expiresAt,
      minVoucherDelta: this.config.minVoucherDelta
        ? BigInt(this.config.minVoucherDelta)
        : undefined,
      now: Math.floor(Date.now() / 1000),
      perRequest: requirements.amount ? BigInt(requirements.amount) : undefined,
      signatureBase58: voucher.signature,
      signer: voucher.signer,
    });
  }

  /**
   * The highest accepted voucher as a settle/finalize argument, or undefined.
   *
   * @param state - The channel state
   * @returns The voucher, or undefined when nothing is accepted yet
   */
  private highestVoucher(state: ChannelState) {
    if (state.cumulative <= 0n || !state.highestVoucherSignature) return undefined;
    return {
      authorizedSigner: state.authorizedSigner,
      cumulativeAmount: state.cumulative,
      expiresAt: BigInt(state.highestVoucherExpiresAt ?? 0),
      signatureBase58: state.highestVoucherSignature,
    };
  }

  /**
   * The effective channel program id.
   *
   * @returns The program id (base58)
   */
  private programId(): string {
    return this.config.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;
  }

  /**
   * Coerce an optional program id string to an Address.
   *
   * @param value - The program id (base58), if any
   * @returns The address, or undefined
   */
  private maybeProgramId(value: string | undefined): Address | undefined {
    return value ? address(value) : undefined;
  }
}

/**
 * Project channel state to the wire snapshot.
 *
 * @param state - The channel state
 * @returns The snapshot
 */
function snapshot(state: ChannelState): BatchChannelSnapshot {
  return {
    channelId: state.channelId,
    deposit: state.deposit.toString(),
    paidOut: state.paidOut.toString(),
    settled: state.settled.toString(),
    status: state.status,
  };
}
