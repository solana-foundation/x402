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
} from "../../src/batch-settlement/client/channel";
import { BatchSvmScheme as BatchServerScheme } from "../../src/batch-settlement/server/scheme";
import { MemoryChannelStore } from "../../src/batch-settlement/server/storage";
import {
  isBatchChannelConfig,
  isBatchPayload,
  type BatchChannelConfig,
  type BatchDepositPayload,
} from "../../src/batch-settlement/types";
import { TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";

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

    expect(
      isBatchChannelConfig({ ...serverDeposit.channelConfig, voucherSigner: "unknown" }),
    ).toBe(false);
    expect(
      isBatchChannelConfig({ ...serverDeposit.channelConfig, voucherSigner: "client" }),
    ).toBe(true);
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
    await expect(clientTracker.authorization()).rejects.toThrow(/do not use operator authorization/);
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

  it("opens and advances a server-signed channel through the server hook lifecycle", async () => {
    const store = new MemoryChannelStore();
    const server = new BatchServerScheme({
      getReplayResponse: async () => ({ body: { replayed: true }, status: 200 }),
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
        maxClaimableAmount: "2000",
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
    await expect(
      server.schemeHooks.onBeforeSettle!({
        ...authorizationContext,
        phase: "before-handler",
      }),
    ).resolves.toMatchObject({
      skip: true,
      result: {
        extra: { commitmentId: `${channelId}:2000` },
        success: true,
      },
    });
    expect(await store.get(channelId)).toMatchObject({
      authorizationRecords: { "request-2": "2000" },
      chargedCumulativeAmount: 2_000n,
      signedMaxClaimable: 2_000n,
    });

    const replayPayment = {
      ...authorizationPayment,
      payload: { ...authorizationPayment.payload },
    } as PaymentPayload;
    const replayContext = { ...authorizationContext, paymentPayload: replayPayment };
    const replayVerified = await server.schemeHooks.onBeforeVerify!(replayContext);
    expect(replayVerified).toMatchObject({ skip: true });
    await expect(
      server.schemeHooks.onAfterVerify!({
        ...replayContext,
        result: (replayVerified as { result: { isValid: true; payer: string } }).result,
      }),
    ).resolves.toMatchObject({ skipHandler: true, response: { body: { replayed: true } } });
  });
});
