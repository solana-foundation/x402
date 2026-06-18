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
import { encodeVoucherMessageBytes } from "../../src/payment-channels/voucher";
import { UptoSvmScheme as UptoServerScheme } from "../../src/upto/server/scheme";
import {
  ERR_SETTLEMENT_EXCEEDS_AMOUNT,
  UptoSvmScheme as UptoFacilitatorScheme,
} from "../../src/upto/facilitator/scheme";
import { UPTO_PROFILE_PAYMENT_CHANNEL, type UptoSvmPayloadV2 } from "../../src/types";

// A valid 32-byte base58 pubkey reused as a deterministic blockhash in tests.
const DUMMY_BLOCKHASH = USDC_MAINNET_ADDRESS;
const PAY_TO = USDC_MAINNET_ADDRESS; // any valid base58 pubkey works as the recipient
const MINT = USDC_DEVNET_ADDRESS;
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

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
          extra: { facilitatorAddress: "Op111", feePayer: "Op111" },
        },
        [],
      );
      expect(result.extra).toEqual({
        custom: "value",
        facilitatorAddress: "Op111",
        feePayer: "Op111",
      });
    });
  });

  describe("voucher encoding (cross-language golden)", () => {
    it("encodes channelId ‖ cumulative_le ‖ expiresAt_le into 48 bytes", () => {
      const channelId = USDC_MAINNET_ADDRESS;
      const bytes = encodeVoucherMessageBytes({
        channelId,
        cumulativeAmount: 1_000_000n,
        expiresAt: BigInt(FAR_FUTURE),
      });
      expect(bytes.byteLength).toBe(48);

      // bytes[0..32] == base58-decoded channelId
      const channelBytes = getBase58Encoder().encode(channelId) as Uint8Array;
      expect(Array.from(bytes.slice(0, 32))).toEqual(Array.from(channelBytes));

      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(view.getBigUint64(32, true)).toBe(1_000_000n); // cumulative, little-endian
      expect(view.getBigInt64(40, true)).toBe(BigInt(FAR_FUTURE)); // expiresAt, little-endian
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
        operator: operator.address,
        payee: PAY_TO,
        payer,
        salt,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const derived = await findPaymentChannelPda({
        authorizedSigner: operator.address,
        mint: MINT,
        payee: PAY_TO,
        payer: payer.address,
        salt,
      });
      expect(open.channelId).toBe(derived);
      expect(open.deposit).toBe(1_000_000n);
    });

    it("verifyOpenTransaction accepts a well-formed open and extracts facts", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      const result = await verifyOpenTransaction(open.transaction, {
        authorizedSigner: operator.address,
        maxCap: 1_000_000n,
        mint: MINT,
        payee: PAY_TO,
      });
      expect(result.channelId).toBe(open.channelId);
      expect(result.deposit).toBe(1_000_000n);
      expect(result.payer).toBe(payer.address);
    });

    it("verifyOpenTransaction rejects a deposit above the ceiling", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 2_000_000n,
        mint: MINT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: operator.address,
          maxCap: 1_000_000n,
          mint: MINT,
          payee: PAY_TO,
        }),
      ).rejects.toThrow(/exceeds maxCap/);
    });

    it("verifyOpenTransaction rejects a mismatched payee", async () => {
      const payer = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const open = await buildOpenPaymentChannelTransaction({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        deposit: 1_000_000n,
        mint: MINT,
        operator: operator.address,
        payee: PAY_TO,
        payer,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      await expect(
        verifyOpenTransaction(open.transaction, {
          authorizedSigner: operator.address,
          maxCap: 1_000_000n,
          mint: MINT,
          payee: USDC_DEVNET_ADDRESS, // wrong recipient
        }),
      ).rejects.toThrow(/payee/);
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
        operator: operator.address,
        payee: PAY_TO,
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
        profile: UPTO_PROFILE_PAYMENT_CHANNEL,
        validAfter: 0,
      };
    });

    const requirements = (overrides: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
      scheme: "upto",
      network: SOLANA_DEVNET_CAIP2,
      asset: MINT,
      amount: "1000000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { facilitatorAddress: operatorAddress, feePayer: operatorAddress },
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
        extra: { facilitatorAddress: "OtherOperator11111111111111111111111111" },
      });
      const result = await facilitator.verify(wrap(basePayload, req), req);
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("facilitator_mismatch");
    });

    it("rejects maxAmount ≠ requirements.amount", async () => {
      const result = await facilitator.verify(
        wrap(basePayload, requirements()),
        requirements({ amount: "999999" }),
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_amount_mismatch");
    });

    it("rejects a deposit below the ceiling", async () => {
      const payload = { ...basePayload, deposit: "500000" };
      const result = await facilitator.verify(wrap(payload, requirements()), requirements());
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe("invalid_upto_svm_payload_deposit_below_ceiling");
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
        profile: UPTO_PROFILE_PAYMENT_CHANNEL,
        validAfter: 0,
      };
      const requirements: PaymentRequirements = {
        scheme: "upto",
        network: SOLANA_DEVNET_CAIP2,
        asset: MINT,
        amount: "1000001", // one over the ceiling
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { facilitatorAddress: operator.address, feePayer: operator.address },
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
