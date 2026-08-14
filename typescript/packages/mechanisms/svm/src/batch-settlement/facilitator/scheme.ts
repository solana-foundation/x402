/* eslint-disable jsdoc/require-jsdoc, jsdoc/require-param-description, jsdoc/require-returns */
import { type Address, address } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { verifyRequestCloseTransaction } from "../../payment-channels/close";
import {
  discoverChannelsByRentPayer,
  type DiscoveredChannel,
} from "../../payment-channels/discovery";
import { fetchMaybeChannel, type Channel } from "../../payment-channels/generated/accounts/channel";
import {
  buildDistributeInstruction,
  buildSealInstruction,
  buildSettleInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import {
  findPaymentChannelPda,
  parseU64,
  verifyOpenTransaction,
} from "../../payment-channels/open";
import { encodeVoucherMessageBytes, verifyVoucherSignature } from "../../payment-channels/voucher";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSigningCapabilities, FacilitatorSvmSigner } from "../../signer";
import {
  broadcastOpen,
  channelExists,
  simulateOpenSettleDistribute,
  submitSettle,
} from "../../upto/facilitator/channel";
import { createRpcClient } from "../../utils";
import { BatchError } from "../errors";
import {
  BATCH_SETTLEMENT_SCHEME,
  type BatchChannelConfig,
  type BatchChannelState,
  type BatchDepositPayload,
  type BatchClaimPayload,
  type BatchPayload,
  type BatchRefundPayload,
  type BatchSettlePayload,
  isBatchFacilitatorPayload,
  isBatchPayload,
} from "../types";
import { type ChannelState, type ChannelStore, MemoryChannelStore } from "../store";

const CHANNEL_STATUS_OPEN = 0;
const CHANNEL_STATUS_CLOSING = 1;
const CHANNEL_STATUS_SEALED = 2;
const CHANNEL_STATUS_DISTRIBUTED = 3;
const MIN_WITHDRAW_DELAY = 900;
const MAX_WITHDRAW_DELAY = 2_592_000;
const DEFAULT_SETTLEMENT_BUFFER_SECONDS = 60;
const CHANNEL_READ_ATTEMPTS = 5;
const CHANNEL_READ_INITIAL_BACKOFF_MS = 200;

/** Four Ed25519+settle pairs fit under Solana's transaction packet limit. */
export const MAX_CHANNELS_PER_SETTLE_TX = 4;

export interface BatchSvmFacilitatorConfig {
  rpcUrl?: string | undefined;
  store?: ChannelStore | undefined;
  settlementBufferSeconds?: number | undefined;
  maxPriorityFeeMicroLamports?: number | undefined;
  maxComputeUnits?: number | undefined;
  maxRequiredSignatures?: number | undefined;
}

type BatchTerms = {
  feePayer: string;
  feePayerSigner: FacilitatorSigningCapabilities;
  receiverAuthorizer?: string | undefined;
  tokenProgram: string;
  withdrawDelay: number;
  memo?: string | undefined;
};

type ValidatedDeposit = {
  payload: BatchDepositPayload;
  terms: BatchTerms;
  channelId: string;
  deposit: bigint;
  charge: bigint;
};

export class BatchSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  readonly caipFamily = "solana:*";
  private readonly store: ChannelStore;
  private readonly settlementCache = new SettlementCache();

  constructor(
    private readonly signer: FacilitatorSvmSigner,
    private readonly config: BatchSvmFacilitatorConfig = {},
  ) {
    if (typeof signer.getSigner !== "function") {
      throw new Error("BatchSvmScheme requires getSigner on the facilitator signer");
    }
    if (signer.getAddresses().length === 0) {
      throw new Error("BatchSvmScheme requires at least one fee payer signer");
    }
    this.store = config.store ?? new MemoryChannelStore();
  }

  getExtra(_: Network): Record<string, unknown> {
    const addresses = this.signer.getAddresses();
    return {
      feePayer: addresses[Math.floor(Math.random() * addresses.length)],
      paymentFlow: "escrow",
    };
  }

  getSigners(_: string): string[] {
    return [...this.signer.getAddresses()];
  }

  getChannelStore(): ChannelStore {
    return this.store;
  }

  /**
   * Rebuild the facilitator's onchain lifecycle view after local index loss.
   *
   * @param network - Network to scan
   * @returns Canonical channels sponsored by any configured fee payer
   */
  async discoverChannels(network: Network): Promise<DiscoveredChannel[]> {
    const rpc = createRpcClient(network, this.config.rpcUrl);
    const channels = await Promise.all(
      this.signer.getAddresses().map(rentPayer => discoverChannelsByRentPayer(rpc, rentPayer)),
    );
    return [...new Map(channels.flat().map(item => [item.channelId, item])).values()];
  }

  async verify(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const payload = payment.payload;
    if (!isBatchPayload(payload)) return this.verifyFailure(BatchError.PAYLOAD_TYPE, "");
    if (
      payment.accepted.scheme !== BATCH_SETTLEMENT_SCHEME ||
      requirements.scheme !== BATCH_SETTLEMENT_SCHEME
    ) {
      return this.verifyFailure("unsupported_scheme", payload.channelConfig.payer);
    }
    if (payment.accepted.network !== requirements.network) {
      return this.verifyFailure("network_mismatch", payload.channelConfig.payer);
    }

    try {
      switch (payload.type) {
        case "deposit": {
          const validated = await this.validateDeposit(payload, requirements);
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: { channelId: validated.channelId },
          };
        }
        case "voucher": {
          const terms = await this.resolveTerms(payload.channelConfig, requirements);
          const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
          if (payload.voucher.channelId !== channelId) {
            return this.verifyFailure(BatchError.CHANNEL_ID_MISMATCH, payload.channelConfig.payer);
          }
          const state = await this.validateVoucherOnly(payload, requirements, terms.withdrawDelay);
          return {
            isValid: true,
            payer: payload.channelConfig.payer,
            extra: snapshot(state),
          };
        }
        case "refund": {
          const state = await this.validateRefund(payload, requirements);
          return {
            isValid: true,
            payer: state.payer,
            extra: snapshot(state),
          };
        }
      }
    } catch (error) {
      return this.verifyFailure(
        classifyError(error),
        payload.channelConfig.payer,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async settle(
    payment: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const payload = payment.payload;
    if (!isBatchFacilitatorPayload(payload)) {
      return this.settleFailure(payment, BatchError.PAYLOAD_TYPE, "");
    }
    try {
      switch (payload.type) {
        case "deposit":
          return await this.settleDeposit(payment, payload, requirements);
        case "voucher":
          return await this.settleVoucher(payment, payload, requirements);
        case "refund":
          return await this.settleRefund(payment, payload, requirements);
        case "claim":
          return await this.settleClaims(payment, payload, requirements);
        case "settle":
          return await this.settleDistributions(payment, payload, requirements);
      }
    } catch (error) {
      return this.settleFailure(
        payment,
        classifyError(error),
        "channelConfig" in payload ? payload.channelConfig.payer : "",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async settleClaims(
    payment: PaymentPayload,
    payload: BatchClaimPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void payment;
    const prepared: {
      channel: Channel;
      channelId: string;
      feePayer: string;
      instructions: ServerInstruction[];
      cumulative: bigint;
    }[] = [];
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    for (const claim of payload.claims) {
      const terms = await this.resolveTerms(claim.voucher.channelConfig, requirements);
      const channelId = await this.deriveChannelId(claim.voucher.channelConfig, terms.feePayer);
      if (channelId !== claim.voucher.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      const cumulative = parseU64(claim.voucher.maxClaimableAmount, "maxClaimableAmount");
      this.assertExpiry(claim.voucher.expiresAt, terms.withdrawDelay);
      const channel = await this.fetchChannel(rpc, channelId);
      this.assertClaimChannel(channel, claim.voucher.channelConfig, terms, requirements);
      if (cumulative <= channel.settlement.settled || cumulative > channel.deposit) {
        throw new Error(BatchError.CUMULATIVE_AMOUNT_MISMATCH);
      }
      const voucher = {
        authorizedSigner: claim.voucher.channelConfig.payerAuthorizer,
        cumulativeAmount: cumulative,
        expiresAt: BigInt(claim.voucher.expiresAt),
        signatureBase58: claim.signature,
      };
      const valid = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: cumulative,
          expiresAt: voucher.expiresAt,
        }),
        signatureBase58: claim.signature,
        signerBase58: voucher.authorizedSigner,
      });
      if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
      prepared.push({
        channel,
        channelId,
        cumulative,
        feePayer: terms.feePayer,
        instructions: buildSettleInstructions({ channelId, voucher }),
      });
    }
    const feePayer = prepared[0]?.feePayer;
    if (!feePayer || prepared.some(item => item.feePayer !== feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    const signature = await submitSettle(
      this.resolveFeePayer(feePayer),
      rpc,
      prepared.flatMap(item => item.instructions),
    );
    const accepts = [];
    for (const item of prepared) {
      const confirmed = await this.fetchChannel(rpc, item.channelId);
      if (confirmed.settlement.settled !== item.cumulative) {
        throw new Error(BatchError.CHANNEL_STATE);
      }
      accepts.push({ channelId: item.channelId, totalClaimed: item.cumulative.toString() });
    }
    return {
      amount: "",
      extra: { accepts },
      network: requirements.network,
      payer: "",
      success: true,
      transaction: signature,
    };
  }

  async settleDistributions(
    payment: PaymentPayload,
    payload: BatchSettlePayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void payment;
    if (payload.channels.length > MAX_CHANNELS_PER_SETTLE_TX) {
      throw new Error(`${BatchError.PAYLOAD_TYPE}: too many channels`);
    }
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const prepared: { channelId: string; feePayer: string; instruction: ServerInstruction }[] = [];
    for (const entry of payload.channels) {
      const terms = await this.resolveTerms(entry.channelConfig, requirements);
      const channelId = await this.deriveChannelId(entry.channelConfig, terms.feePayer);
      if (channelId !== entry.channelId) throw new Error(BatchError.CHANNEL_ID_MISMATCH);
      const channel = await this.fetchChannel(rpc, channelId);
      this.assertClaimChannel(channel, entry.channelConfig, terms, requirements, true);
      prepared.push({
        channelId,
        feePayer: terms.feePayer,
        instruction: await this.distributeInstruction(
          stateFromChannel(channelId, channel, entry.channelConfig, terms, requirements),
          requirements.network,
        ),
      });
    }
    const feePayer = prepared[0]?.feePayer;
    if (!feePayer || prepared.some(item => item.feePayer !== feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    const signature = await submitSettle(
      this.resolveFeePayer(feePayer),
      rpc,
      prepared.map(item => item.instruction),
    );
    return {
      amount: "",
      extra: { channels: prepared.map(item => item.channelId) },
      network: requirements.network,
      payer: "",
      success: true,
      transaction: signature,
    };
  }

  async settleBatch(channelIds: string[], network: Network): Promise<string[]> {
    const now = Math.floor(Date.now() / 1000);
    const pending = new Map<
      string,
      { channelId: string; cumulative: bigint; instructions: ServerInstruction[] }[]
    >();
    for (const channelId of channelIds) {
      const state = await this.store.get(channelId);
      if (!state || state.status !== "open" || state.signedMaxClaimable <= state.settled) continue;
      const voucher = highestVoucher(state);
      if (!voucher || (voucher.expiresAt !== 0n && voucher.expiresAt <= BigInt(now))) continue;
      const group = pending.get(state.feePayer) ?? [];
      group.push({
        channelId,
        cumulative: state.signedMaxClaimable,
        instructions: buildSettleInstructions({ channelId, voucher }),
      });
      pending.set(state.feePayer, group);
    }
    const rpc = createRpcClient(network, this.config.rpcUrl);
    const signatures: string[] = [];
    for (const [feePayer, entries] of pending) {
      for (let index = 0; index < entries.length; index += MAX_CHANNELS_PER_SETTLE_TX) {
        const group = entries.slice(index, index + MAX_CHANNELS_PER_SETTLE_TX);
        const signature = await submitSettle(
          this.resolveFeePayer(feePayer),
          rpc,
          group.flatMap(entry => entry.instructions),
        );
        signatures.push(signature);
        for (const entry of group) {
          await this.store.update(entry.channelId, current => {
            if (!current) throw new Error("channel disappeared");
            return { ...current, settled: entry.cumulative };
          });
        }
      }
    }
    return signatures;
  }

  async distribute(channelId: string, network: Network): Promise<string | null> {
    const state = await this.store.get(channelId);
    if (!state || state.status !== "open" || state.settled <= state.payoutWatermark) return null;
    const instruction = await this.distributeInstruction(state, network);
    const signature = await submitSettle(
      this.resolveFeePayer(state.feePayer),
      createRpcClient(network, this.config.rpcUrl),
      [instruction],
    );
    await this.store.update(channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return { ...current, payoutWatermark: current.settled };
    });
    return signature;
  }

  /**
   * Finalize a payer-forced close after its onchain grace deadline.
   *
   * @param channelId
   * @param network
   */
  async finalizeRefund(channelId: string, network: Network): Promise<string | null> {
    const state = await this.requireState(channelId);
    const rpc = createRpcClient(network, this.config.rpcUrl);
    const channel = await this.fetchChannel(rpc, channelId);
    if (channel.status === CHANNEL_STATUS_DISTRIBUTED) {
      await this.markDistributed(state, channel);
      return null;
    }
    const instructions: ServerInstruction[] = [];
    if (channel.status === CHANNEL_STATUS_CLOSING) {
      const deadline = channel.closureStartedAt + BigInt(channel.gracePeriod);
      if (BigInt(Math.floor(Date.now() / 1000)) < deadline) return null;
      instructions.push(buildSealInstruction({ channelId }));
    } else if (channel.status !== CHANNEL_STATUS_SEALED) {
      throw new Error(`${BatchError.CLOSE_STATE}: channel is not closing or sealed`);
    }
    instructions.push(await this.distributeInstruction(state, network));
    const signature = await submitSettle(this.resolveFeePayer(state.feePayer), rpc, instructions);
    const confirmed = await this.fetchChannel(rpc, channelId);
    if (confirmed.status !== CHANNEL_STATUS_DISTRIBUTED) {
      throw new Error(`${BatchError.CLOSE_STATE}: close finalization did not distribute`);
    }
    await this.markDistributed(state, confirmed);
    return signature;
  }

  private async validateDeposit(
    payload: BatchDepositPayload,
    requirements: PaymentRequirements,
  ): Promise<ValidatedDeposit> {
    const terms = await this.resolveTerms(payload.channelConfig, requirements);
    const deposit = parseU64(payload.deposit.amount, "deposit.amount");
    const charge = parseU64(requirements.amount, "amount");
    const voucherAmount = parseU64(payload.voucher.maxClaimableAmount, "maxClaimableAmount");
    if (voucherAmount !== charge || voucherAmount > deposit) {
      throw new Error(`${BatchError.CUMULATIVE_AMOUNT_MISMATCH}: invalid first voucher amount`);
    }
    const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
    if (payload.voucher.channelId !== channelId) {
      throw new Error(`${BatchError.CHANNEL_ID_MISMATCH}: voucher channel mismatch`);
    }
    const voucherValid = await verifyVoucherSignature({
      message: encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: voucherAmount,
        expiresAt: BigInt(payload.voucher.expiresAt),
      }),
      signatureBase58: payload.voucher.signature,
      signerBase58: payload.channelConfig.payerAuthorizer,
    });
    if (!voucherValid) throw new Error(`${BatchError.VOUCHER_SIGNATURE}: invalid voucher`);
    this.assertExpiry(payload.voucher.expiresAt, terms.withdrawDelay);
    const open = await verifyOpenTransaction(payload.deposit.transaction, {
      authorizedSigner: payload.channelConfig.payerAuthorizer,
      feePayer: terms.feePayer,
      from: payload.channelConfig.payer,
      maxCap: deposit,
      maxComputeUnits: this.config.maxComputeUnits,
      maxPriorityFeeMicroLamports: this.config.maxPriorityFeeMicroLamports,
      maxRequiredSignatures: this.config.maxRequiredSignatures,
      memo: terms.memo,
      mint: requirements.asset,
      openSlot: BigInt(payload.channelConfig.openSlot),
      payee: terms.feePayer,
      recentSlot: parseOptionalSlot(requirements.extra?.recentSlot),
      recipients: [{ bps: 10_000, recipient: requirements.payTo }],
      tokenProgram: terms.tokenProgram,
      withdrawDelay: terms.withdrawDelay,
    });
    if (open.channelId !== channelId) {
      throw new Error(`${BatchError.CHANNEL_ID_MISMATCH}: setup transaction channel mismatch`);
    }
    return { channelId, charge, deposit, payload, terms };
  }

  private async settleDeposit(
    payment: PaymentPayload,
    payload: BatchDepositPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const validated = await this.validateDeposit(payload, requirements);
    const { channelId, terms } = validated;
    const existing = await this.store.get(channelId);
    if (existing?.openSignature) return depositResponse(existing, requirements.network);
    const key = `batch:deposit:${requirements.network}:${channelId}`;
    if (this.settlementCache.isDuplicate(key)) {
      return this.settleFailure(payment, "duplicate_settlement", payload.channelConfig.payer);
    }
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    if (await channelExists(rpc, channelId)) {
      this.settlementCache.delete(key);
      throw new Error(`${BatchError.CHANNEL_STATE}: channel already exists without local binding`);
    }
    await simulateOpenSettleDistribute(terms.feePayerSigner, rpc, {
      channel: {
        channelId,
        mint: requirements.asset,
        network: requirements.network,
        payee: terms.feePayer,
        payer: payload.channelConfig.payer,
        rentPayer: terms.feePayer,
        splits: [{ bps: 10_000, recipient: requirements.payTo }],
        tokenProgram: terms.tokenProgram,
      },
      openTransactionBase64: payload.deposit.transaction,
    });
    const state = initialState(validated, requirements);
    await this.store.put(state);
    let signature: string;
    try {
      signature = await broadcastOpen(
        this.signer,
        address(terms.feePayer),
        requirements.network,
        payload.deposit.transaction,
      );
    } catch (error) {
      this.settlementCache.delete(key);
      throw error;
    }
    const channel = await this.fetchChannel(rpc, channelId);
    this.assertOnchainChannel(channel, state);
    const withSignature = await this.store.update(channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return { ...current, openSignature: signature };
    });
    return depositResponse(withSignature, requirements.network);
  }

  private async settleVoucher(
    payment: PaymentPayload,
    payload: Extract<BatchPayload, { type: "voucher" }>,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    void requirements;
    return this.settleFailure(payment, BatchError.PAYLOAD_TYPE, payload.channelConfig.payer);
  }

  private async validateVoucherOnly(
    payload: Extract<BatchPayload, { type: "voucher" }>,
    requirements: PaymentRequirements,
    withdrawDelay: number,
  ): Promise<ChannelState> {
    const state = await this.requireState(payload.voucher.channelId);
    this.assertStoredConfig(state, payload.channelConfig);
    if (state.status !== "open") throw new Error(BatchError.CHANNEL_CLOSING);
    const cumulative = parseU64(payload.voucher.maxClaimableAmount, "maxClaimableAmount");
    if (cumulative > state.deposit) throw new Error(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
    this.assertExpiry(payload.voucher.expiresAt, withdrawDelay);
    const valid = await verifyVoucherSignature({
      message: encodeVoucherMessageBytes({
        channelId: state.channelId,
        cumulativeAmount: cumulative,
        expiresAt: BigInt(payload.voucher.expiresAt),
      }),
      signatureBase58: payload.voucher.signature,
      signerBase58: state.payerAuthorizer,
    });
    if (!valid) throw new Error(BatchError.VOUCHER_SIGNATURE);
    const channel = await this.fetchChannel(
      createRpcClient(requirements.network, this.config.rpcUrl),
      state.channelId,
    );
    this.assertOnchainChannel(channel, state);
    return state;
  }

  private async validateRefund(
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<ChannelState> {
    const terms = await this.resolveTerms(payload.channelConfig, requirements);
    const channelId = await this.deriveChannelId(payload.channelConfig, terms.feePayer);
    const state = await this.requireState(channelId);
    this.assertStoredConfig(state, payload.channelConfig);
    await verifyRequestCloseTransaction(payload.transaction, {
      channelId,
      feePayer: terms.feePayer,
      maxComputeUnits: this.config.maxComputeUnits,
      maxPriorityFeeMicroLamports: this.config.maxPriorityFeeMicroLamports,
      memo: terms.memo,
      payer: payload.channelConfig.payer,
    });
    if (state.status === "distributed") {
      throw new Error(`${BatchError.CLOSE_STATE}: channel is already distributed`);
    }
    return state;
  }

  private async settleRefund(
    payment: PaymentPayload,
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const state = await this.validateRefund(payload, requirements);
    if (state.status === "closing") {
      const channel = await this.fetchChannel(
        createRpcClient(requirements.network, this.config.rpcUrl),
        state.channelId,
      );
      if (channel.status !== CHANNEL_STATUS_CLOSING) {
        throw new Error(`${BatchError.CLOSE_STATE}: stored close is not Closing onchain`);
      }
      this.assertOnchainBinding(channel, state);
      return refundResponse(state, requirements.network);
    }
    const key = `batch:refund:${requirements.network}:${state.channelId}:${payload.transaction}`;
    if (this.settlementCache.isDuplicate(key)) {
      return this.settleFailure(payment, "duplicate_settlement", state.payer);
    }
    let signature: string;
    try {
      await this.signer.simulateTransaction(
        await this.signer.signTransaction(
          payload.transaction,
          address(state.feePayer),
          requirements.network,
        ),
        requirements.network,
      );
      signature = await broadcastOpen(
        this.signer,
        address(state.feePayer),
        requirements.network,
        payload.transaction,
      );
    } catch (error) {
      this.settlementCache.delete(key);
      throw error;
    }
    const channel = await this.fetchChannel(
      createRpcClient(requirements.network, this.config.rpcUrl),
      state.channelId,
    );
    if (channel.status !== CHANNEL_STATUS_CLOSING) {
      throw new Error(`${BatchError.CLOSE_STATE}: request_close did not enter Closing`);
    }
    const closing = await this.store.update(state.channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return {
        ...current,
        closeRequestedAt: Number(channel.closureStartedAt),
        closeSignature: signature,
        status: "closing",
      };
    });
    return refundResponse(closing, requirements.network);
  }

  private async resolveTerms(
    config: BatchChannelConfig,
    requirements: PaymentRequirements,
  ): Promise<BatchTerms> {
    const extra = requirements.extra;
    if (extra?.paymentFlow !== "escrow") throw new Error(BatchError.PAYMENT_FLOW);
    const feePayer = extra.feePayer;
    if (typeof feePayer !== "string") throw new Error(BatchError.FEE_PAYER_MISMATCH);
    const feePayerSigner = this.resolveFeePayer(feePayer);
    if (config.payer === feePayer || config.payerAuthorizer === feePayer) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    const withdrawDelay = extra.withdrawDelay;
    if (
      typeof withdrawDelay !== "number" ||
      !Number.isInteger(withdrawDelay) ||
      withdrawDelay < MIN_WITHDRAW_DELAY ||
      withdrawDelay > MAX_WITHDRAW_DELAY ||
      withdrawDelay < requirements.maxTimeoutSeconds
    ) {
      throw new Error(BatchError.WITHDRAW_DELAY_OUT_OF_RANGE);
    }
    if (config.withdrawDelay !== withdrawDelay) throw new Error(BatchError.WITHDRAW_DELAY_MISMATCH);
    if (config.receiver !== requirements.payTo || config.token !== requirements.asset) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
    const receiverAuthorizer = extra.receiverAuthorizer;
    if (
      (receiverAuthorizer === undefined) !== (config.receiverAuthorizer === undefined) ||
      (receiverAuthorizer !== undefined && receiverAuthorizer !== config.receiverAuthorizer)
    ) {
      throw new Error(BatchError.RECEIVER_AUTHORIZER_MISMATCH);
    }
    const tokenProgram = extra.tokenProgram;
    if (tokenProgram !== TOKEN_PROGRAM_ADDRESS && tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS) {
      throw new Error(BatchError.TOKEN_PROGRAM);
    }
    const rpc = createRpcClient(requirements.network, this.config.rpcUrl);
    const mint = await fetchMint(rpc, requirements.asset as Address);
    if (mint.programAddress.toString() !== tokenProgram) throw new Error(BatchError.TOKEN_PROGRAM);
    const memo = extra.memo;
    if (memo !== undefined && typeof memo !== "string")
      throw new Error(BatchError.SETUP_TRANSACTION);
    return {
      feePayer,
      feePayerSigner,
      ...(memo !== undefined ? { memo } : {}),
      ...(typeof receiverAuthorizer === "string" ? { receiverAuthorizer } : {}),
      tokenProgram,
      withdrawDelay,
    };
  }

  private async deriveChannelId(config: BatchChannelConfig, feePayer: string): Promise<string> {
    return findPaymentChannelPda({
      authorizedSigner: config.payerAuthorizer,
      mint: config.token,
      openSlot: parseU64(config.openSlot, "channelConfig.openSlot"),
      payee: feePayer,
      payer: config.payer,
      salt: parseU64(config.salt, "channelConfig.salt"),
    });
  }

  private assertExpiry(expiresAt: number, withdrawDelay: number): void {
    if (expiresAt === 0) return;
    const minimum =
      Math.floor(Date.now() / 1000) +
      withdrawDelay +
      (this.config.settlementBufferSeconds ?? DEFAULT_SETTLEMENT_BUFFER_SECONDS);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < minimum) {
      throw new Error(BatchError.EXPIRY_WINDOW_TOO_SHORT);
    }
  }

  private resolveFeePayer(feePayer: string): FacilitatorSigningCapabilities {
    if (!this.signer.getAddresses().some(value => value === feePayer)) {
      throw new Error(BatchError.FEE_PAYER_MISMATCH);
    }
    return this.signer.getSigner!(address(feePayer));
  }

  private async requireState(channelId: string): Promise<ChannelState> {
    const state = await this.store.get(channelId);
    if (!state) throw new Error(BatchError.CHANNEL_NOT_FOUND);
    return state;
  }

  private async fetchChannel(
    rpc: ReturnType<typeof createRpcClient>,
    channelId: string,
  ): Promise<Channel> {
    for (let attempt = 0; attempt < CHANNEL_READ_ATTEMPTS; attempt += 1) {
      const account = await fetchMaybeChannel(rpc, address(channelId), { commitment: "confirmed" });
      if (account.exists) return account.data;
      if (attempt + 1 < CHANNEL_READ_ATTEMPTS) {
        await new Promise(resolve =>
          setTimeout(resolve, CHANNEL_READ_INITIAL_BACKOFF_MS * 2 ** attempt),
        );
      }
    }
    throw new Error(`${BatchError.CHANNEL_STATE}: channel is not visible after confirmation`);
  }

  private assertOnchainChannel(channel: Channel, state: ChannelState): void {
    if (channel.status !== CHANNEL_STATUS_OPEN) {
      throw new Error(`${BatchError.CHANNEL_STATE}: channel is not open`);
    }
    this.assertOnchainBinding(channel, state);
  }

  private assertOnchainBinding(channel: Channel, state: ChannelState): void {
    if (
      channel.payer !== state.payer ||
      channel.payee !== state.feePayer ||
      channel.rentPayer !== state.feePayer ||
      channel.authorizedSigner !== state.payerAuthorizer ||
      channel.mint !== state.mint ||
      channel.deposit !== state.deposit ||
      channel.gracePeriod !== state.withdrawDelay ||
      channel.salt !== state.salt ||
      channel.openSlot !== state.openSlot
    ) {
      throw new Error(`${BatchError.CHANNEL_STATE}: confirmed channel binding mismatch`);
    }
  }

  private assertClaimChannel(
    channel: Channel,
    config: BatchChannelConfig,
    terms: BatchTerms,
    requirements: PaymentRequirements,
    allowSealed = false,
  ): void {
    if (
      (channel.status !== CHANNEL_STATUS_OPEN &&
        (!allowSealed || channel.status !== CHANNEL_STATUS_SEALED)) ||
      channel.payer !== config.payer ||
      channel.payee !== terms.feePayer ||
      channel.rentPayer !== terms.feePayer ||
      channel.authorizedSigner !== config.payerAuthorizer ||
      channel.mint !== requirements.asset ||
      channel.gracePeriod !== terms.withdrawDelay ||
      channel.salt !== BigInt(config.salt) ||
      channel.openSlot !== BigInt(config.openSlot)
    ) {
      throw new Error(BatchError.CHANNEL_STATE);
    }
  }

  private assertStoredConfig(state: ChannelState, config: BatchChannelConfig): void {
    if (JSON.stringify(state.channelConfig) !== JSON.stringify(config)) {
      throw new Error(`${BatchError.CHANNEL_STATE}: channelConfig changed`);
    }
  }

  private async distributeInstruction(
    state: ChannelState,
    network: Network,
  ): Promise<ServerInstruction> {
    return buildDistributeInstruction({
      channelId: state.channelId,
      mint: state.mint,
      network,
      payee: state.feePayer,
      payer: state.payer,
      rentPayer: state.feePayer,
      splits: [{ bps: 10_000, recipient: state.receiver }],
      tokenProgram: state.tokenProgram,
    });
  }

  private async markDistributed(state: ChannelState, channel: Channel): Promise<void> {
    await this.store.update(state.channelId, current => {
      if (!current) throw new Error("channel disappeared");
      return {
        ...current,
        payoutWatermark: channel.settlement.payoutWatermark,
        settled: channel.settlement.settled,
        status: "distributed",
      };
    });
  }

  private verifyFailure(reason: string, payer: string, message?: string): VerifyResponse {
    return {
      isValid: false,
      invalidReason: reason,
      ...(message ? { invalidMessage: message } : {}),
      payer,
    };
  }

  private settleFailure(
    payment: PaymentPayload,
    reason: string,
    payer: string,
    message?: string,
  ): SettleResponse {
    return {
      success: false,
      network: payment.accepted.network,
      transaction: "",
      errorReason: reason,
      ...(message ? { errorMessage: message } : {}),
      payer,
    };
  }
}

function initialState(
  validated: ValidatedDeposit,
  requirements: PaymentRequirements,
): ChannelState {
  const { payload, terms } = validated;
  return {
    channelConfig: payload.channelConfig,
    channelId: validated.channelId,
    chargedCumulativeAmount: 0n,
    deposit: validated.deposit,
    feePayer: terms.feePayer,
    mint: requirements.asset,
    openSlot: BigInt(payload.channelConfig.openSlot),
    payer: payload.channelConfig.payer,
    payerAuthorizer: payload.channelConfig.payerAuthorizer,
    payoutWatermark: 0n,
    receiver: requirements.payTo,
    receiverAuthorizer: terms.receiverAuthorizer,
    salt: BigInt(payload.channelConfig.salt),
    settled: 0n,
    signedMaxClaimable: 0n,
    status: "open",
    tokenProgram: terms.tokenProgram,
    withdrawDelay: terms.withdrawDelay,
  };
}

function stateFromChannel(
  channelId: string,
  channel: Channel,
  config: BatchChannelConfig,
  terms: BatchTerms,
  requirements: PaymentRequirements,
): ChannelState {
  return {
    channelConfig: config,
    channelId,
    chargedCumulativeAmount: channel.settlement.settled,
    deposit: channel.deposit,
    feePayer: terms.feePayer,
    mint: requirements.asset,
    openSlot: channel.openSlot,
    payer: channel.payer,
    payerAuthorizer: channel.authorizedSigner,
    payoutWatermark: channel.settlement.payoutWatermark,
    receiver: requirements.payTo,
    receiverAuthorizer: terms.receiverAuthorizer,
    salt: channel.salt,
    settled: channel.settlement.settled,
    signedMaxClaimable: channel.settlement.settled,
    status: "open",
    tokenProgram: terms.tokenProgram,
    withdrawDelay: channel.gracePeriod,
  };
}

function highestVoucher(state: ChannelState) {
  if (state.signedMaxClaimable === 0n || !state.highestVoucherSignature) return undefined;
  return {
    authorizedSigner: state.payerAuthorizer,
    cumulativeAmount: state.signedMaxClaimable,
    expiresAt: BigInt(state.highestVoucherExpiresAt ?? 0),
    signatureBase58: state.highestVoucherSignature,
  };
}

function snapshot(state: ChannelState): BatchChannelState {
  return {
    balance: state.deposit.toString(),
    channelId: state.channelId,
    chargedCumulativeAmount: state.chargedCumulativeAmount.toString(),
    totalClaimed: state.settled.toString(),
    withdrawRequestedAt: state.closeRequestedAt ?? 0,
  };
}

function depositResponse(state: ChannelState, network: Network): SettleResponse {
  return {
    amount: state.deposit.toString(),
    network,
    payer: state.payer,
    success: true,
    transaction: state.openSignature ?? "",
    extra: {
      chargedAmount: state.chargedCumulativeAmount.toString(),
      channelState: snapshot(state),
      commitmentId: `${state.channelId}:${state.signedMaxClaimable}`,
    },
  };
}

function refundResponse(state: ChannelState, network: Network): SettleResponse {
  return {
    network,
    payer: state.payer,
    success: true,
    transaction: state.closeSignature ?? "",
    extra: { channelState: snapshot(state) },
  };
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const known = Object.values(BatchError).find(value => message.includes(value));
  return known ?? "transaction_failed";
}

function parseOptionalSlot(value: unknown): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  return parseU64(value as string | number | bigint, "extra.recentSlot");
}
