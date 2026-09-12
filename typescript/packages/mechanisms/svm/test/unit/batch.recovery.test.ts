import { address, generateKeyPairSigner, type Signature } from "@solana/kit";
import { InMemoryPendingSettlementStore } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { signBatchVoucher } from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchSvmScheme } from "../../src/batch-settlement/facilitator/scheme";
import type {
  BatchChannelConfig,
  BatchClaimPayload,
  BatchRefundPayload,
  BatchSettlePayload,
} from "../../src/batch-settlement/types";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import type { Channel } from "../../src/payment-channels/generated/accounts/channel";
import { getChannelDistributionHash } from "../../src/payment-channels/facilitator";
import { ChannelStatus } from "../../src/payment-channels/onchain";

const NETWORK = SOLANA_DEVNET_CAIP2;
const MINT = USDC_DEVNET_ADDRESS;
const RECEIVER = USDC_MAINNET_ADDRESS;
const TX = USDC_DEVNET_ADDRESS as Signature;

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let channelId: string;
let channelConfig: BatchChannelConfig;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  channelId = USDC_MAINNET_ADDRESS;
  channelConfig = {
    openSlot: 1,
    payer: payer.address,
    payerAuthorizer: payer.address,
    receiver: RECEIVER,
    salt: "0",
    token: MINT,
    withdrawDelay: 900,
  };
});

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: MINT,
    extra: {
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: RECEIVER,
    scheme: "batch-settlement",
  };
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    authorizedSigner: address(payer.address),
    bump: 1,
    closureStartedAt: 0n,
    deposit: 10_000n,
    discriminator: 1,
    distributionHash: getChannelDistributionHash([{ bps: 10_000, recipient: RECEIVER }]),
    gracePeriod: 900,
    mint: address(MINT),
    openSlot: 1n,
    payee: address(feePayer.address),
    payer: address(payer.address),
    payerWithdrawnAt: 0n,
    rentPayer: address(feePayer.address),
    salt: 0n,
    settlement: { payoutWatermark: 0n, settled: 0n },
    status: ChannelStatus.Open,
    version: 1,
    ...overrides,
  };
}

function signer(confirmTransaction = vi.fn().mockResolvedValue(undefined)) {
  return {
    confirmTransaction,
    getAccountInfo: vi.fn(),
    getAddresses: vi.fn(() => [feePayer.address]),
    getSigner: vi.fn(() => feePayer),
    sendTransaction: vi.fn().mockResolvedValue(TX),
    signTransaction: vi.fn().mockResolvedValue("signed"),
    simulateTransaction: vi.fn().mockResolvedValue(undefined),
  };
}

type RecoveryInternals = {
  broadcastDurably: ReturnType<typeof vi.fn>;
  completeOrPending(
    key: string,
    signature: string,
    network: typeof NETWORK,
    payer: string,
  ): Promise<SettleResponse | undefined>;
  deriveChannelId: ReturnType<typeof vi.fn>;
  distributeInstruction: ReturnType<typeof vi.fn>;
  fetchChannel: ReturnType<typeof vi.fn>;
  fetchChannelsUntil: ReturnType<typeof vi.fn>;
  fetchChannelUntil: ReturnType<typeof vi.fn>;
  forgetPending(key: string): Promise<void>;
  prepareRefund: ReturnType<typeof vi.fn>;
  readChannel: ReturnType<typeof vi.fn>;
  reconcileBroadcast: ReturnType<typeof vi.fn>;
  resolveTerms: ReturnType<typeof vi.fn>;
  submitRedemption: ReturnType<typeof vi.fn>;
  trackChannel: ReturnType<typeof vi.fn>;
  waitForChannelRead: ReturnType<typeof vi.fn>;
  settleRefund(
    payment: PaymentPayload,
    payload: BatchRefundPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse>;
};

function configure(scheme: BatchSvmScheme): RecoveryInternals {
  const api = scheme as unknown as RecoveryInternals;
  api.resolveTerms = vi.fn().mockResolvedValue({
    feePayer: feePayer.address,
    feePayerSigner: feePayer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    voucherSigner: "client",
    withdrawDelay: 900,
  });
  api.deriveChannelId = vi.fn().mockResolvedValue(channelId);
  api.trackChannel = vi.fn().mockResolvedValue(undefined);
  api.distributeInstruction = vi.fn().mockResolvedValue({
    accounts: [],
    data: new Uint8Array([7]),
    programAddress: address(RECEIVER),
  });
  return api;
}

async function claimPayload(amount = 1_000n): Promise<BatchClaimPayload> {
  const signed = await signBatchVoucher(payer, {
    channelId,
    expiresAt: 0,
    maxClaimableAmount: amount,
  });
  return {
    claims: [
      {
        signature: signed.signature,
        voucher: {
          channelConfig,
          channelId,
          expiresAt: 0,
          maxClaimableAmount: amount.toString(),
        },
      },
    ],
    type: "claim",
  };
}

function payment(payload: unknown): PaymentPayload {
  return { accepted: requirements(), payload, x402Version: 2 } as PaymentPayload;
}

describe("batch-settlement outcome recovery", () => {
  it("retries a stale claim read after confirmation", async () => {
    const scheme = new BatchSvmScheme(signer() as never);
    const api = configure(scheme);
    api.readChannel = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(channel())
      .mockResolvedValue(channel({ settlement: { payoutWatermark: 0n, settled: 1_000n } }));
    api.submitRedemption = vi.fn().mockResolvedValue({ ok: true, replayed: false, signature: TX });
    const payload = await claimPayload();

    await expect(
      scheme.settleClaims(payment(payload), payload, requirements()),
    ).resolves.toMatchObject({
      extra: { accepts: [{ channelId, totalClaimed: "1000" }], replayed: false },
      success: true,
      transaction: TX,
    });
    expect(api.readChannel).toHaveBeenCalledTimes(3);
    expect(api.submitRedemption).toHaveBeenCalledOnce();
  });

  it("recovers a lost claim response after restart and never credits an unrelated watermark", async () => {
    const payload = await claimPayload();
    const key = `batch:claim:${NETWORK}:${channelId}:1000`;
    const store = new InMemoryPendingSettlementStore();
    await store.set(key, TX);
    const confirm = vi.fn().mockResolvedValue(undefined);
    const recovering = new BatchSvmScheme(signer(confirm) as never, {
      pendingSettlementStore: store,
    });
    const recoveryApi = configure(recovering);
    recoveryApi.readChannel = vi
      .fn()
      .mockResolvedValue(channel({ settlement: { payoutWatermark: 0n, settled: 1_000n } }));
    recoveryApi.submitRedemption = vi.fn();

    const recovered = await recovering.settleClaims(payment(payload), payload, requirements());
    expect(recovered).toMatchObject({ success: true, transaction: TX });
    expect(confirm).toHaveBeenCalledOnce();
    expect(recoveryApi.submitRedemption).not.toHaveBeenCalled();
    expect(await store.get(key)).toBeUndefined();
    expect(await store.get(`${key}:completed`)).toBe(TX);

    const restarted = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const restartedApi = configure(restarted);
    restartedApi.readChannel = vi.fn();
    restartedApi.submitRedemption = vi.fn();
    await expect(
      restarted.settleClaims(payment(payload), payload, requirements()),
    ).resolves.toMatchObject({ extra: { replayed: true }, success: true, transaction: TX });
    expect(restartedApi.readChannel).not.toHaveBeenCalled();
    expect(restartedApi.submitRedemption).not.toHaveBeenCalled();

    const unrelated = new BatchSvmScheme(signer() as never);
    const unrelatedApi = configure(unrelated);
    unrelatedApi.readChannel = vi
      .fn()
      .mockResolvedValue(channel({ settlement: { payoutWatermark: 0n, settled: 2_000n } }));
    unrelatedApi.submitRedemption = vi.fn();
    await expect(unrelated.settleClaims(payment(payload), payload, requirements())).rejects.toThrow(
      BatchError.CUMULATIVE_AMOUNT_MISMATCH,
    );
    expect(unrelatedApi.submitRedemption).not.toHaveBeenCalled();
  });

  it("recovers distribution once and reports duplicate payout volume as zero", async () => {
    const payload: BatchSettlePayload = {
      channels: [{ channelConfig, channelId, payoutWatermark: "200", settled: "1000" }],
      type: "settle",
    };
    const key = `batch:distribute:${NETWORK}:${channelId}:200:1000`;
    const store = new InMemoryPendingSettlementStore();
    await store.set(key, TX);
    const recovering = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const recoveryApi = configure(recovering);
    recoveryApi.readChannel = vi
      .fn()
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 200n, settled: 1_000n } }))
      .mockResolvedValue(channel({ settlement: { payoutWatermark: 1_000n, settled: 1_000n } }));
    recoveryApi.submitRedemption = vi.fn();
    const concurrent = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const concurrentApi = configure(concurrent);
    concurrentApi.readChannel = vi
      .fn()
      .mockResolvedValue(channel({ settlement: { payoutWatermark: 1_000n, settled: 1_000n } }));
    concurrentApi.submitRedemption = vi.fn();

    const results = await Promise.all([
      recovering.settleDistributions(payment(payload), payload, requirements()),
      concurrent.settleDistributions(payment(payload), payload, requirements()),
    ]);
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result).toMatchObject({
        amount: "0",
        extra: {
          payouts: [{ channelId, payoutWatermark: "1000" }],
          replayed: true,
        },
        success: true,
        transaction: TX,
      });
    }
    expect(recoveryApi.readChannel).toHaveBeenCalledTimes(2);
    expect(recoveryApi.submitRedemption).not.toHaveBeenCalled();
    expect(concurrentApi.submitRedemption).not.toHaveBeenCalled();

    const restarted = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const restartedApi = configure(restarted);
    restartedApi.readChannel = vi.fn();
    restartedApi.submitRedemption = vi.fn();
    await expect(
      restarted.settleDistributions(payment(payload), payload, requirements()),
    ).resolves.toMatchObject({
      amount: "0",
      extra: { replayed: true },
      success: true,
      transaction: TX,
    });
    expect(restartedApi.submitRedemption).not.toHaveBeenCalled();

    const unrelated = new BatchSvmScheme(signer() as never);
    const unrelatedApi = configure(unrelated);
    unrelatedApi.readChannel = vi
      .fn()
      .mockResolvedValue(channel({ settlement: { payoutWatermark: 2_000n, settled: 2_000n } }));
    unrelatedApi.submitRedemption = vi.fn();
    await expect(
      unrelated.settleDistributions(payment(payload), payload, requirements()),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    expect(unrelatedApi.submitRedemption).not.toHaveBeenCalled();
  });

  it("recovers request_close after stale reads and remains replayable after cleanup", async () => {
    const payload: BatchRefundPayload = {
      channelConfig,
      transaction: "signed-close",
      type: "refund",
    };
    const key = `batch:refund:${NETWORK}:${channelId}:signed-close`;
    const store = new InMemoryPendingSettlementStore();
    await store.set(key, TX);
    const recovering = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const recoveryApi = configure(recovering);
    recoveryApi.prepareRefund = vi.fn().mockResolvedValue({
      channelId,
      terms: await recoveryApi.resolveTerms(channelConfig, requirements()),
    });
    recoveryApi.readChannel = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockResolvedValue(channel({ closureStartedAt: 20n, status: ChannelStatus.Closing }));

    await expect(
      recoveryApi.settleRefund(payment(payload), payload, requirements()),
    ).resolves.toMatchObject({
      extra: { channelState: { withdrawRequestedAt: 20 }, replayed: true },
      success: true,
      transaction: TX,
    });
    expect(recoveryApi.readChannel).toHaveBeenCalledTimes(2);

    const completedReplay = new BatchSvmScheme(signer() as never, {
      pendingSettlementStore: store,
    });
    const completedReplayApi = configure(completedReplay);
    completedReplayApi.prepareRefund = vi.fn().mockResolvedValue({
      channelId,
      terms: await completedReplayApi.resolveTerms(channelConfig, requirements()),
    });
    completedReplayApi.readChannel = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockResolvedValue(channel({ closureStartedAt: 20n, status: ChannelStatus.Closing }));
    await expect(
      completedReplayApi.settleRefund(payment(payload), payload, requirements()),
    ).resolves.toMatchObject({ extra: { replayed: true }, success: true, transaction: TX });
    expect(completedReplayApi.readChannel).toHaveBeenCalledTimes(2);

    const restarted = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const restartedApi = configure(restarted);
    restartedApi.prepareRefund = vi.fn().mockResolvedValue({
      channelId,
      terms: await restartedApi.resolveTerms(channelConfig, requirements()),
    });
    restartedApi.readChannel = vi.fn().mockResolvedValue(undefined);
    await expect(
      restartedApi.settleRefund(payment(payload), payload, requirements()),
    ).resolves.toMatchObject({
      extra: { replayed: true },
      success: true,
      transaction: TX,
    });
  });

  it("retains exact transaction identity when recovered postconditions are still stale", async () => {
    const claim = await claimPayload();
    const distribute: BatchSettlePayload = {
      channels: [{ channelConfig, channelId, payoutWatermark: "0", settled: "1000" }],
      type: "settle",
    };
    const refund: BatchRefundPayload = {
      channelConfig,
      transaction: "signed-close",
      type: "refund",
    };
    const store = new InMemoryPendingSettlementStore();
    await store.set(`batch:claim:${NETWORK}:${channelId}:1000`, TX);
    await store.set(`batch:distribute:${NETWORK}:${channelId}:0:1000`, TX);
    await store.set(`batch:refund:${NETWORK}:${channelId}:signed-close`, TX);
    const scheme = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const api = configure(scheme);
    api.reconcileBroadcast = vi.fn().mockResolvedValue({
      ok: true,
      replayed: false,
      signature: TX,
    });
    api.fetchChannelsUntil = vi.fn().mockResolvedValue(undefined);
    api.fetchChannelUntil = vi.fn().mockResolvedValue(false);
    api.prepareRefund = vi.fn().mockResolvedValue({
      channelId,
      terms: await api.resolveTerms(channelConfig, requirements()),
    });

    await expect(scheme.settleClaims(payment(claim), claim, requirements())).resolves.toMatchObject(
      {
        errorReason: "settlement_pending",
        transaction: TX,
      },
    );
    await expect(
      scheme.settleDistributions(payment(distribute), distribute, requirements()),
    ).resolves.toMatchObject({ errorReason: "settlement_pending", transaction: TX });
    await expect(api.settleRefund(payment(refund), refund, requirements())).resolves.toMatchObject({
      errorReason: "settlement_pending",
      transaction: TX,
    });
  });

  it("propagates terminal reconciliation responses for every recovered operation", async () => {
    const claim = await claimPayload();
    const distribute: BatchSettlePayload = {
      channels: [{ channelConfig, channelId, payoutWatermark: "0", settled: "1000" }],
      type: "settle",
    };
    const refund: BatchRefundPayload = {
      channelConfig,
      transaction: "signed-close",
      type: "refund",
    };
    const store = new InMemoryPendingSettlementStore();
    await store.set(`batch:claim:${NETWORK}:${channelId}:1000`, TX);
    await store.set(`batch:distribute:${NETWORK}:${channelId}:0:1000`, TX);
    await store.set(`batch:refund:${NETWORK}:${channelId}:signed-close`, TX);
    const scheme = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const api = configure(scheme);
    const failure = {
      errorReason: "transaction_failed",
      network: NETWORK,
      success: false,
      transaction: TX,
    } as SettleResponse;
    api.reconcileBroadcast = vi.fn().mockResolvedValue({ ok: false, response: failure });
    api.prepareRefund = vi.fn().mockResolvedValue({
      channelId,
      terms: await api.resolveTerms(channelConfig, requirements()),
    });

    await expect(scheme.settleClaims(payment(claim), claim, requirements())).resolves.toBe(failure);
    await expect(
      scheme.settleDistributions(payment(distribute), distribute, requirements()),
    ).resolves.toBe(failure);
    await expect(api.settleRefund(payment(refund), refund, requirements())).resolves.toBe(failure);
  });

  it("handles a concurrent completion race without rebuilding or rebroadcasting", async () => {
    const claim = await claimPayload();
    const distribute: BatchSettlePayload = {
      channels: [{ channelConfig, channelId, payoutWatermark: "0", settled: "1000" }],
      type: "settle",
    };
    const refund: BatchRefundPayload = {
      channelConfig,
      transaction: "signed-close",
      type: "refund",
    };
    const scheme = new BatchSvmScheme(signer() as never);
    const api = configure(scheme);
    api.fetchChannel = vi
      .fn()
      .mockResolvedValueOnce(channel())
      .mockResolvedValueOnce(channel({ settlement: { payoutWatermark: 0n, settled: 1_000n } }))
      .mockResolvedValueOnce(channel());
    api.submitRedemption = vi.fn().mockResolvedValue({ ok: true, replayed: true, signature: TX });
    api.prepareRefund = vi.fn().mockResolvedValue({
      channelId,
      terms: await api.resolveTerms(channelConfig, requirements()),
    });
    api.broadcastDurably = vi.fn().mockResolvedValue({ ok: true, replayed: true, signature: TX });

    await expect(scheme.settleClaims(payment(claim), claim, requirements())).resolves.toMatchObject(
      {
        extra: { replayed: true },
        transaction: TX,
      },
    );
    await expect(
      scheme.settleDistributions(payment(distribute), distribute, requirements()),
    ).resolves.toMatchObject({ amount: "0", extra: { replayed: true }, transaction: TX });
    await expect(api.settleRefund(payment(refund), refund, requirements())).resolves.toMatchObject({
      extra: { replayed: true },
      transaction: TX,
    });
  });

  it("returns pending when completion storage fails and bounds postcondition polling", async () => {
    const store = {
      delete: vi.fn().mockRejectedValue(new Error("delete unavailable")),
      get: vi.fn().mockResolvedValue(undefined),
      set: vi.fn().mockRejectedValue(new Error("write unavailable")),
    };
    const scheme = new BatchSvmScheme(signer() as never, { pendingSettlementStore: store });
    const api = configure(scheme);
    await expect(api.completeOrPending("key", TX, NETWORK, payer.address)).resolves.toMatchObject({
      errorReason: "settlement_pending",
      transaction: TX,
    });
    await expect(api.forgetPending("key")).resolves.toBeUndefined();

    api.readChannel = vi.fn().mockResolvedValue(channel());
    api.waitForChannelRead = vi.fn().mockResolvedValue(undefined);
    await expect(api.fetchChannelUntil(NETWORK, channelId, () => false)).resolves.toBe(false);
    await expect(
      api.fetchChannelsUntil(NETWORK, [channelId], () => false),
    ).resolves.toBeUndefined();
    expect(api.waitForChannelRead).toHaveBeenCalledTimes(8);
  });
});
