import { generateKeyPairSigner, getBase58Encoder } from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/constants";
import {
  buildOpenPaymentChannelTransaction,
  findPaymentChannelPda,
  verifyOpenTransaction,
} from "../../src/payment-channels/open";
import { encodeVoucherMessageBytes, VOUCHER_MAGIC } from "../../src/payment-channels/voucher";
import { UptoSvmScheme as UptoClientScheme } from "../../src/upto/client/scheme";
import { UptoSvmScheme as UptoServerScheme } from "../../src/upto/server/scheme";
import {
  ERR_SETTLEMENT_EXCEEDS_AMOUNT,
  UptoSvmScheme as UptoFacilitatorScheme,
} from "../../src/upto/facilitator/scheme";
import { UPTO_ASSET_TRANSFER_METHOD, type UptoSvmPayloadV2 } from "../../src/types";

// A valid 32-byte base58 pubkey reused as a deterministic blockhash in tests.
const DUMMY_BLOCKHASH = USDC_MAINNET_ADDRESS;
const PAY_TO = USDC_MAINNET_ADDRESS; // any valid base58 pubkey works as the recipient
const MINT = USDC_DEVNET_ADDRESS;
const FAR_FUTURE = 4_102_444_800; // 2100-01-01
// Challenge-bound open slot (`extra.recentSlot`), a channel-PDA seed.
const OPEN_SLOT = 123_456_789n;

describe("upto SVM scheme", () => {
  describe("server.parsePrice", () => {
    const server = new UptoServerScheme();

    it("parses dollar prices to 6-decimal atomic units", async () => {
      const result = await server.parsePrice("$0.10", SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("100000");
      expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
    });

    it("uses the devnet USDC mint on devnet", async () => {
      const result = await server.parsePrice("1.00", SOLANA_DEVNET_CAIP2);
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(USDC_DEVNET_ADDRESS);
    });

    it("passes through pre-parsed AssetAmount", async () => {
      const result = await server.parsePrice(
        { amount: "500", asset: "CustomMint1111111111111111111111111111", extra: {} },
        SOLANA_MAINNET_CAIP2,
      );
      expect(result.amount).toBe("500");
    });
  });

  describe("server.enhancePaymentRequirements", () => {
    it("folds the facilitator binding into extra", async () => {
      const server = new UptoServerScheme();
      const requirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { custom: "value" },
      } as PaymentRequirements;

      const result = await server.enhancePaymentRequirements(
        requirements,
        {
          x402Version: 2,
          scheme: "upto",
          network: SOLANA_DEVNET_CAIP2,
          extra: {
            assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
            facilitatorAddress: "Op111",
            facilitatorFee: 25,
          },
        },
        [],
      );
      expect(result.extra).toEqual({
        assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
        custom: "value",
        facilitatorAddress: "Op111",
        facilitatorFee: 25,
      });
    });
  });

  describe("voucher encoding (cross-language golden)", () => {
    it("encodes magic ‖ channelId ‖ cumulative_le ‖ expiresAt_le into 50 bytes", () => {
      const channelId = USDC_MAINNET_ADDRESS;
      const bytes = encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: 1_000_000n,
        expiresAt: BigInt(FAR_FUTURE),
      });
      expect(bytes.byteLength).toBe(50);

      // bytes[0..2] == constant magic [0x56, 0x01]
      expect(Array.from(bytes.slice(0, 2))).toEqual([...VOUCHER_MAGIC]);
      expect([...VOUCHER_MAGIC]).toEqual([0x56, 0x01]);

      // bytes[2..34] == base58-decoded channelId
      const channelBytes = getBase58Encoder().encode(channelId) as Uint8Array;
      expect(Array.from(bytes.slice(2, 34))).toEqual(Array.from(channelBytes));

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getBigUint64(34, true)).toBe(1_000_000n); // cumulative, little-endian
      expect(view.getBigInt64(42, true)).toBe(BigInt(FAR_FUTURE)); // expiresAt, little-endian
    });
  });

  describe("payment-channel open", () => {
    it("derives the same channel PDA the open transaction commits to", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const salt = 42n;
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        salt,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const derived = await findPaymentChannelPda({
        authorizedSigner: operator.address,
        mint: MINT,
        openSlot: OPEN_SLOT,
        payee: PAY_TO,
        payer: payer.address,
        salt,
      });
      expect(open.channelId).toBe(derived);
      expect(open.deposit).toBe(1_000_000n);
      expect(open.openSlot).toBe(OPEN_SLOT);

      // open_slot is a PDA seed: a different slot yields a different channel.
      const otherSlot = await findPaymentChannelPda({
        authorizedSigner: operator.address,
        mint: MINT,
        openSlot: OPEN_SLOT + 1n,
        payee: PAY_TO,
        payer: payer.address,
        salt,
      });
      expect(otherSlot).not.toBe(derived);
    });

    it("verifyOpenTransaction accepts a well-formed open and extracts facts", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: operator.address,
        operator: operator.address,
        maxCap: 1_000_000n,
        mint: MINT,
        payee: PAY_TO,
      });
      expect(result.channelId).toBe(open.channelId);
      expect(result.deposit).toBe(1_000_000n);
      expect(result.openSlot).toBe(OPEN_SLOT);
      expect(result.payer).toBe(payer.address);
    });

    it("verifyOpenTransaction accepts a delegated facilitator split", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const split = { bps: 9_875, recipient: PAY_TO };
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: operator.address,
        payer,
        recipients: [split],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: operator.address,
        operator: operator.address,
        maxCap: 1_000_000n,
        mint: MINT,
        payee: operator.address,
        recipients: [split],
      });
      expect(result.recipients).toEqual([split]);
    });

    it("verifyOpenTransaction rejects a mismatched delegated split", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: operator.address,
        payer,
        recipients: [{ bps: 9_900, recipient: PAY_TO }],
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: operator.address,
          operator: operator.address,
          maxCap: 1_000_000n,
          mint: MINT,
          payee: operator.address,
          recipients: [{ bps: 9_875, recipient: PAY_TO }],
        }),
      ).rejects.toThrow(/distribution bps/);
    });

    it("verifyOpenTransaction rejects a deposit above the ceiling", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 2_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: operator.address,
          operator: operator.address,
          maxCap: 1_000_000n,
          mint: MINT,
          payee: PAY_TO,
        }),
      ).rejects.toThrow(/!= maxCap/);
    });

    it("verifyOpenTransaction rejects a deposit below the ceiling", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 500_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: operator.address,
          operator: operator.address,
          maxCap: 1_000_000n,
          mint: MINT,
          payee: PAY_TO,
        }),
      ).rejects.toThrow(/!= maxCap/);
    });

    it("verifyOpenTransaction rejects a mismatched payee", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: operator.address,
          operator: operator.address,
          maxCap: 1_000_000n,
          mint: MINT,
          payee: USDC_DEVNET_ADDRESS, // wrong recipient
        }),
      ).rejects.toThrow(/payee/);
    });
  });

  describe("client.createPaymentPayload", () => {
    it("builds a delegated open with the payTo split and decimal salt nonce", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const client = new UptoClientScheme(payer);
      const requirements: PaymentRequirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
          facilitatorAddress: operator.address,
          facilitatorFee: 125,
          recentBlockhash: DUMMY_BLOCKHASH,
          recentSlot: OPEN_SLOT.toString(),
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        },
      };

      const result = await client.createPaymentPayload(2, requirements);
      const payload = result.payload as unknown as UptoSvmPayloadV2;
      const open = await verifyOpenTransaction(payload.openTransaction, {
        authorizedSigner: operator.address,
        operator: operator.address,
        maxCap: 1_000_000n,
        mint: MINT,
        payee: operator.address,
        recipients: [{ bps: 9_875, recipient: PAY_TO }],
      });

      expect(payload.authorizedSigner).toBe(operator.address);
      expect(payload.channelId).toBe(open.channelId);
      expect(payload.nonce).toBe(open.salt.toString());
      expect(open.openSlot).toBe(OPEN_SLOT); // challenge slot, not a client-fetched one
      expect(payload).not.toHaveProperty("profile");
    });

    it("rejects a challenge without extra.recentSlot (never fetches its own slot)", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const client = new UptoClientScheme(payer);
      const requirements: PaymentRequirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000000",
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
          facilitatorAddress: operator.address,
          facilitatorFee: 125,
          recentBlockhash: DUMMY_BLOCKHASH,
          tokenProgram: TOKEN_PROGRAM_ADDRESS,
        },
      };

      await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(
        /extra\.recentSlot/,
      );
    });
  });

  describe("facilitator verify (pre-broadcast rejections)", () => {
    let operatorAddress: string;
    let facilitator: UptoFacilitatorScheme;
    let basePayload: UptoSvmPayloadV2;

    beforeAll(async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      operatorAddress = operator.address;
      facilitator = new UptoFacilitatorScheme(operator);
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: operator.address,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      basePayload = {
        authorizedSigner: operator.address,
        channelId: open.channelId,
        deposit: "1000000",
        expiresAt: FAR_FUTURE,
        from: payer.address,
        maxAmount: "1000000",
        nonce: "n-1",
        openTransaction: open.transaction,
        validAfter: 0,
      };
    });

    const requirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
      scheme: "upto",
      network: SOLANA_DEVNET_CAIP2,
      asset: MINT,
      amount: "1000000",
      payTo: operatorAddress,
      maxTimeoutSeconds: 300,
      extra: {
        assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
        facilitatorAddress: operatorAddress,
        facilitatorFee: 0,
      },
      ...overrides,
    });

    const wrap = (payload: UptoSvmPayloadV2, req: PaymentRequirements): PaymentPayload => ({
      x402Version: 2,
      accepted: req,
      payload: payload as unknown as Record<string, unknown>,
    });

    it("rejects a non-upto payload shape", async () => {
      const result = await facilitator.verify(
        { x402Version: 2, accepted: requirements(), payload: { transaction: "x" } },
        requirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("unsupported_payload_type");
    });

    it("rejects a network mismatch", async () => {
      const req = requirements();
      const result = await facilitator.verify(
        wrap(basePayload, req),
        requirements({ network: SOLANA_MAINNET_CAIP2 }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("network_mismatch");
    });

    it("rejects a facilitator-address mismatch", async () => {
      const req = requirements({
        extra: {
          assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
          facilitatorAddress: "OtherOperator11111111111111111111111111",
          facilitatorFee: 0,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("facilitator_mismatch");
    });

    it("rejects a missing payment-channel assetTransferMethod", async () => {
      const req = requirements({ extra: { facilitatorAddress: operatorAddress } });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects a non-integer facilitator fee", async () => {
      const req = requirements({
        extra: {
          assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
          facilitatorAddress: operatorAddress,
          facilitatorFee: 12.5,
        },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects a nonzero facilitator fee without facilitatorAddress", async () => {
      const req = requirements({
        extra: { assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD, facilitatorFee: 100 },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payment_requirements");
    });

    it("rejects maxAmount ≠ requirements.amount", async () => {
      const result = await facilitator.verify(
        wrap(basePayload, requirements()),
        requirements({ amount: "999999" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_amount_mismatch");
    });

    it("rejects a deposit below the ceiling (must equal exactly)", async () => {
      const payload = { ...basePayload, deposit: "500000" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_deposit_not_ceiling");
    });

    it("rejects a deposit above the ceiling (must equal exactly)", async () => {
      const payload = { ...basePayload, deposit: "2000000" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_deposit_not_ceiling");
    });

    it("rejects delegated requirements when the open omits the payTo split", async () => {
      const result = await facilitator.verify(
        wrap(basePayload, requirements()),
        requirements({ payTo: PAY_TO }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_open_transaction");
      expect(result.invalidMessage).toMatch(/distribution recipients/);
    });

    it("rejects a payload channelId that does not match the open transaction", async () => {
      const result = await facilitator.verify(
        wrap({ ...basePayload, channelId: PAY_TO }, requirements()),
        requirements(),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_channel_id");
    });

    it("rejects an expired authorization", async () => {
      const payload = { ...basePayload, expiresAt: 1 };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_expired");
    });

    it("rejects a not-yet-active authorization", async () => {
      const payload = { ...basePayload, validAfter: FAR_FUTURE };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_not_yet_active");
    });

    it("rejects a non-operator authorized signer", async () => {
      const payload = {
        ...basePayload,
        authorizedSigner: "NotTheOperator111111111111111111111111",
      };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_authorized_signer");
    });

    it("rejects an undecodable open transaction", async () => {
      const payload = { ...basePayload, openTransaction: "not-a-valid-transaction" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_open_transaction");
    });
  });

  describe("facilitator settle (ceiling enforcement)", () => {
    it("rejects a settlement above the signed ceiling before any RPC", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const facilitator = new UptoFacilitatorScheme(operator);
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        openSlot: OPEN_SLOT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      const payload: UptoSvmPayloadV2 = {
        authorizedSigner: operator.address,
        channelId: open.channelId,
        deposit: "1000000",
        expiresAt: FAR_FUTURE,
        from: payer.address,
        maxAmount: "1000000",
        nonce: "n-1",
        openTransaction: open.transaction,
        validAfter: 0,
      };
      const requirements: PaymentRequirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000001", // one over the ceiling
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: {
          assetTransferMethod: UPTO_ASSET_TRANSFER_METHOD,
          facilitatorAddress: operator.address,
          facilitatorFee: 0,
        },
      };

      const result = await facilitator.settle(
        {
          x402Version: 2,
          accepted: requirements,
          payload: payload as unknown as Record<string, unknown>,
        },
        requirements,
      );
      expect(result.success).toBe(false);
      expect(result.errorReason).toBe(ERR_SETTLEMENT_EXCEEDS_AMOUNT);
    });
  });
});
