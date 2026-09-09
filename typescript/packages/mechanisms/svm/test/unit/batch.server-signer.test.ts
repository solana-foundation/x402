import { generateKeyPairSigner, getBase58Decoder } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import {
  encodeBatchAuthorizationMessage,
  signBatchAuthorization,
  verifyBatchAuthorization,
} from "../../src/batch-settlement/authorization";
import {
  BatchChannelTracker,
  buildDepositPayload,
  signBatchVoucher,
} from "../../src/batch-settlement/client/channel";
import { BatchError } from "../../src/batch-settlement/errors";
import { BatchSvmScheme as BatchServerScheme } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import {
  isBatchChannelConfig,
  isBatchFacilitatorPayload,
  isBatchPayload,
  isBatchVoucher,
  type BatchChannelConfig,
  type BatchDepositPayload,
  type BatchVoucher,
} from "../../src/batch-settlement/types";
import { TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import {
  encodeVoucherMessageBytes,
  verifyVoucherSignature,
} from "../../src/payment-channels/voucher";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let operator: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let serverDeposit: BatchDepositPayload;

beforeAll(async () => {
  payer = await generateKeyPairSigner();
  operator = await generateKeyPairSigner();
  feePayer = await generateKeyPairSigner();
  serverDeposit = (
    await buildDepositPayload({
      blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: USDC_DEVNET_ADDRESS,
      openSlot: 123n,
      operator: operator.address,
      payer,
      receiver: USDC_MAINNET_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      voucherSigner: "server",
      withdrawDelay: 900,
    })
  ).payload;
});

function requirements(): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: feePayer.address,
      operator: operator.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      voucherSigner: "server",
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: SOLANA_DEVNET_CAIP2,
    payTo: USDC_MAINNET_ADDRESS,
    scheme: "batch-settlement",
  };
}

describe("batch server voucher signer boundaries", () => {
  it("covers malformed top-level wire guards", () => {
    expect(isBatchVoucher(null)).toBe(false);
    expect(isBatchFacilitatorPayload(null)).toBe(false);
    expect(isBatchChannelConfig({ ...serverDeposit.channelConfig, receiverAuthorizer: 1 })).toBe(
      false,
    );
  });

  it("rejects malformed server and client wire combinations", async () => {
    expect(isBatchPayload(serverDeposit)).toBe(true);
    const clientDeposit = (
      await buildDepositPayload({
        blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
        depositAmount: 10_000n,
        feePayer: feePayer.address,
        firstCharge: 1_000n,
        mint: USDC_DEVNET_ADDRESS,
        openSlot: 123n,
        payer,
        receiver: USDC_MAINNET_ADDRESS,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        withdrawDelay: 900,
      })
    ).payload;
    expect(isBatchPayload(clientDeposit)).toBe(true);

    const invalid = [
      { ...serverDeposit, deposit: null },
      { ...serverDeposit, deposit: { ...serverDeposit.deposit, amount: 1 } },
      { ...serverDeposit, deposit: { ...serverDeposit.deposit, transaction: 1 } },
      { ...serverDeposit, voucher: clientDeposit.voucher },
      { ...serverDeposit, authorization: null },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, type: "other" } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, channelId: 1 } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, payer: 1 } },
      { ...serverDeposit, authorization: { ...serverDeposit.authorization, signature: 1 } },
      { ...serverDeposit, idempotencyKey: "" },
      { ...serverDeposit, maxClaimableAmount: 1 },
      { ...clientDeposit, authorization: serverDeposit.authorization },
      { ...clientDeposit, idempotencyKey: "key" },
      { ...clientDeposit, maxClaimableAmount: "1000" },
      {
        channelConfig: serverDeposit.channelConfig,
        type: "voucher",
        voucher: clientDeposit.voucher,
      },
      {
        authorization: serverDeposit.authorization,
        channelConfig: clientDeposit.channelConfig,
        idempotencyKey: "key",
        maxClaimableAmount: "1000",
        type: "authorization",
      },
      {
        authorization: null,
        channelConfig: serverDeposit.channelConfig,
        idempotencyKey: "key",
        maxClaimableAmount: "1000",
        type: "authorization",
      },
      {
        authorization: serverDeposit.authorization,
        channelConfig: serverDeposit.channelConfig,
        idempotencyKey: "",
        maxClaimableAmount: "1000",
        type: "authorization",
      },
      {
        authorization: serverDeposit.authorization,
        channelConfig: serverDeposit.channelConfig,
        idempotencyKey: "key",
        maxClaimableAmount: 1,
        type: "authorization",
      },
    ];
    for (const payload of invalid) expect(isBatchPayload(payload)).toBe(false);

    expect(isBatchChannelConfig({ ...serverDeposit.channelConfig, voucherSigner: "unknown" })).toBe(
      false,
    );
    expect(isBatchChannelConfig({ ...serverDeposit.channelConfig, voucherSigner: "client" })).toBe(
      true,
    );
  });

  it("prevents using the wrong credential API for either signer mode", async () => {
    const serverTracker = new BatchChannelTracker(
      serverDeposit.authorization!.channelId,
      serverDeposit.channelConfig,
      payer,
    );
    await expect(serverTracker.previewVoucher(1n)).rejects.toThrow(/do not use client vouchers/);

    const clientConfig: BatchChannelConfig = {
      ...serverDeposit.channelConfig,
      payerAuthorizer: payer.address,
      voucherSigner: "client",
    };
    const clientTracker = new BatchChannelTracker(
      serverDeposit.authorization!.channelId,
      clientConfig,
      payer,
    );
    await expect(clientTracker.authorization()).rejects.toThrow(/do not use server authorization/);
    await expect(
      buildDepositPayload({
        blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
        depositAmount: 10_000n,
        feePayer: feePayer.address,
        firstCharge: 1_000n,
        mint: USDC_DEVNET_ADDRESS,
        openSlot: 123n,
        payer,
        receiver: USDC_MAINNET_ADDRESS,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        voucherSigner: "server",
        withdrawDelay: 900,
      }),
    ).rejects.toThrow(/operator is required/);
  });

  it("enforces tracker and deposit-builder boundaries in both modes", async () => {
    const clientConfig: BatchChannelConfig = {
      ...serverDeposit.channelConfig,
      payerAuthorizer: payer.address,
      voucherSigner: "client",
    };
    const tracker = new BatchChannelTracker(
      serverDeposit.authorization!.channelId,
      clientConfig,
      payer,
      2n,
    );
    await expect(tracker.previewVoucher(0n)).rejects.toThrow(/positive/);
    expect(() => tracker.commit(1n)).toThrow(/backwards/);
    await expect(
      signBatchVoucher({ address: payer.address, signMessages: async () => [{}] } as never, {
        channelId: serverDeposit.authorization!.channelId,
        expiresAt: 0,
        maxClaimableAmount: 3n,
      }),
    ).rejects.toThrow(/did not return/);

    const base = {
      blockhash: { blockhash: USDC_MAINNET_ADDRESS, lastValidBlockHeight: 1n },
      depositAmount: 10_000n,
      feePayer: feePayer.address,
      firstCharge: 1_000n,
      mint: USDC_DEVNET_ADDRESS,
      openSlot: 123n,
      payer,
      receiver: USDC_MAINNET_ADDRESS,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    };
    await expect(buildDepositPayload({ ...base, firstCharge: 0n })).rejects.toThrow(/positive/);
    await expect(buildDepositPayload({ ...base, firstCharge: 10_001n })).rejects.toThrow(
      /positive/,
    );
    await expect(
      buildDepositPayload({ ...base, openSlot: BigInt(Number.MAX_SAFE_INTEGER) + 1n }),
    ).rejects.toThrow(/safe integer/);
    await expect(
      buildDepositPayload({ ...base, receiverAuthorizer: operator.address }),
    ).resolves.toMatchObject({
      payload: { channelConfig: { receiverAuthorizer: operator.address } },
    });
  });

  it("rejects malformed keys and a signer that returns no proof", async () => {
    const shortKey = getBase58Decoder().decode(new Uint8Array(31));
    expect(() =>
      encodeBatchAuthorizationMessage({
        channelId: shortKey,
        operator: operator.address,
        payer: payer.address,
      }),
    ).toThrow(/decode to 32 bytes/);
    await expect(
      signBatchAuthorization(
        { address: payer.address, signMessages: async () => [{}] } as never,
        serverDeposit.authorization!.channelId,
        operator.address,
      ),
    ).rejects.toThrow(/did not return/);
  });

  it("binds authorization to both the channel and operator", async () => {
    const authorization = serverDeposit.authorization!;
    await expect(verifyBatchAuthorization(authorization, operator.address)).resolves.toBe(true);
    await expect(verifyBatchAuthorization(authorization, feePayer.address)).resolves.toBe(false);
    await expect(
      verifyBatchAuthorization({ ...authorization, channelId: feePayer.address }, operator.address),
    ).resolves.toBe(false);
  });

  it("rejects every server-mode term and proof mismatch", async () => {
    type Internals = {
      signOperatorVoucher(channelId: string, cumulative: bigint): Promise<unknown>;
      validatePayload(raw: BatchDepositPayload, requirements: PaymentRequirements): Promise<string>;
      validateRequestProof(
        raw: BatchDepositPayload,
        channelId: string,
        mode: "client" | "server",
      ): Promise<void>;
    };
    const api = new BatchServerScheme({ operator }) as unknown as Internals;
    const channelId = serverDeposit.authorization!.channelId;
    const req = requirements();
    const withExtra = (extra: Record<string, unknown>) => ({
      ...req,
      extra: { ...req.extra, ...extra },
    });

    await expect(
      api.validatePayload(serverDeposit, withExtra({ voucherSigner: "other" })),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      api.validatePayload(
        {
          ...serverDeposit,
          channelConfig: { ...serverDeposit.channelConfig, voucherSigner: "client" },
        },
        req,
      ),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      api.validatePayload(serverDeposit, withExtra({ operator: feePayer.address })),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);
    await expect(
      api.validatePayload(
        {
          ...serverDeposit,
          channelConfig: { ...serverDeposit.channelConfig, voucherSigner: undefined },
        },
        withExtra({ operator: operator.address, voucherSigner: "client" }),
      ),
    ).rejects.toThrow(BatchError.CHANNEL_STATE);

    await expect(
      api.validateRequestProof(
        { ...serverDeposit, authorization: undefined } as never,
        channelId,
        "server",
      ),
    ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);
    await expect(
      api.validateRequestProof(
        { ...serverDeposit, voucher: undefined } as never,
        channelId,
        "client",
      ),
    ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);

    const authorizationCases = [
      { authorization: { ...serverDeposit.authorization!, channelId: feePayer.address } },
      { authorization: { ...serverDeposit.authorization!, payer: feePayer.address } },
      { idempotencyKey: "" },
      { authorization: { ...serverDeposit.authorization!, signature: "bad" } },
    ];
    for (const overrides of authorizationCases) {
      await expect(
        api.validateRequestProof({ ...serverDeposit, ...overrides } as never, channelId, "server"),
      ).rejects.toThrow(BatchError.VOUCHER_SIGNATURE);
    }

    const unsigned = new BatchServerScheme() as unknown as Internals;
    await expect(unsigned.signOperatorVoucher(channelId, 1n)).rejects.toThrow(
      BatchError.VOUCHER_SIGNATURE,
    );
  });

  it("opens and advances a server-signed channel through the server hook lifecycle", async () => {
    const store = new MemoryChannelStore();
    const server = new BatchServerScheme({
      operator,
      store,
    });
    const depositPayment: PaymentPayload = {
      accepted: requirements(),
      payload: serverDeposit,
      x402Version: 2,
    };
    const depositContext = {
      declaredExtensions: {},
      paymentPayload: depositPayment,
      requirements: requirements(),
    };
    const verified = await server.schemeHooks.onBeforeVerify!(depositContext);
    expect(verified).toMatchObject({ skip: true, result: { isValid: true } });
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...depositContext,
        result: (verified as { result: { isValid: true; payer: string } }).result,
      }),
    ).resolves.toBeUndefined();
    await server.schemeHooks.onAfterSettle!({
      ...depositContext,
      phase: "after-handler",
      result: {
        extra: { channelState: { balance: "10000", totalClaimed: "0", withdrawRequestedAt: 0 } },
        network: SOLANA_DEVNET_CAIP2,
        success: true,
        transaction: "open-signature",
      },
    });
    const channelId = serverDeposit.authorization!.channelId;
    expect(await store.get(channelId)).toMatchObject({
      authorizationSignature: serverDeposit.authorization!.signature,
      chargedCumulativeAmount: 1_000n,
      signedMaxClaimable: 1_000n,
    });

    const authorizationPayment: PaymentPayload = {
      accepted: requirements(),
      payload: {
        authorization: serverDeposit.authorization!,
        channelConfig: serverDeposit.channelConfig,
        idempotencyKey: "request-2",
        type: "authorization",
      },
      x402Version: 2,
    };
    const authorizationContext = {
      declaredExtensions: {},
      paymentPayload: authorizationPayment,
      requirements: requirements(),
    };
    const authorizationVerified = await server.schemeHooks.onBeforeVerify!(authorizationContext);
    expect(authorizationVerified).toMatchObject({ skip: true, result: { isValid: true } });
    await server.schemeHooks.onAfterVerify!({
      ...authorizationContext,
      result: (authorizationVerified as { result: { isValid: true; payer: string } }).result,
    });
    const actualSettlement = await server.schemeHooks.onBeforeSettle!({
      ...authorizationContext,
      requirements: { ...authorizationContext.requirements, amount: "400" },
      phase: "after-handler",
    });
    expect(actualSettlement).toMatchObject({
      skip: true,
      result: {
        extra: { chargedAmount: "400", commitmentId: `${channelId}:1400` },
        success: true,
      },
    });
    const receipt = (actualSettlement as { result: { extra: { voucher: BatchVoucher } } }).result
      .extra.voucher;
    expect(
      await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: 1_400n,
          expiresAt: 0n,
        }),
        signatureBase58: receipt.signature,
        signerBase58: operator.address,
      }),
    ).toBe(true);
    expect(await store.get(channelId)).toMatchObject({
      authorizationRecords: { "request-2": "1400" },
      chargedCumulativeAmount: 1_400n,
      signedMaxClaimable: 1_400n,
    });

    const zeroPayment = {
      ...authorizationPayment,
      payload: { ...authorizationPayment.payload, idempotencyKey: "request-3" },
    } as PaymentPayload;
    const zeroContext = { ...authorizationContext, paymentPayload: zeroPayment };
    const zeroVerified = await server.schemeHooks.onBeforeVerify!(zeroContext);
    await server.schemeHooks.onAfterVerify!({
      ...zeroContext,
      result: (zeroVerified as { result: { isValid: true; payer: string } }).result,
    });
    await expect(
      server.schemeHooks.onBeforeSettle!({
        ...zeroContext,
        requirements: { ...zeroContext.requirements, amount: "0" },
        phase: "after-handler",
      }),
    ).resolves.toMatchObject({
      result: {
        extra: { chargedAmount: "0", commitmentId: `${channelId}:1400` },
        success: true,
      },
    });
    expect(await store.get(channelId)).toMatchObject({
      authorizationRecords: { "request-2": "1400", "request-3": "1400" },
      chargedCumulativeAmount: 1_400n,
    });

    const replayPayment = {
      ...authorizationPayment,
      payload: { ...authorizationPayment.payload },
    } as PaymentPayload;
    const replayContext = { ...authorizationContext, paymentPayload: replayPayment };
    await expect(server.schemeHooks.onBeforeVerify!(replayContext)).resolves.toMatchObject({
      abort: true,
      reason: "duplicate_settlement",
    });
  });
});
