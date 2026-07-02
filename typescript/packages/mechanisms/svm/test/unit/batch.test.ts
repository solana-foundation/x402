import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { beforeAll, describe, expect, it } from "vitest";

import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_MAINNET_CAIP2,
  TOKEN_PROGRAM_ADDRESS,
  USDC_DEVNET_ADDRESS,
  USDC_MAINNET_ADDRESS,
} from "../../src/constants";
import { findPaymentChannelPda, verifyOpenTransaction } from "../../src/payment-channels/open";
import { buildSettleInstructions } from "../../src/payment-channels/onchain";
import { SETTLE_DISCRIMINATOR } from "../../src/payment-channels/generated/instructions/settle";
import {
  verifyVoucherSignature,
  encodeVoucherMessageBytes,
} from "../../src/payment-channels/voucher";
import {
  BatchChannelTracker,
  buildDepositPayload,
  signBatchVoucher,
} from "../../src/batch-settlement/client/channel";
import { acceptVoucher } from "../../src/batch-settlement/facilitator/accept";
import {
  MemoryChannelStore,
  type ChannelState,
} from "../../src/batch-settlement/facilitator/store";
import { BatchSvmScheme as BatchFacilitatorScheme } from "../../src/batch-settlement/facilitator/scheme";
import { BatchSvmScheme as BatchServerScheme } from "../../src/batch-settlement/server/scheme";
import { BatchError } from "../../src/batch-settlement/errors";
import {
  isBatchPayload,
  isBatchVoucher,
  type BatchVoucher,
} from "../../src/batch-settlement/types";

const DUMMY_BLOCKHASH = USDC_MAINNET_ADDRESS;
const PAY_TO = USDC_MAINNET_ADDRESS;
const MINT = USDC_DEVNET_ADDRESS;
const FAR_FUTURE = 4_102_444_800; // 2100-01-01

/** Seed a fully-open channel into a store. */
function seedChannel(
  overrides: Partial<ChannelState> & Pick<ChannelState, "channelId" | "authorizedSigner" | "payer">,
): ChannelState {
  return {
    cumulative: 0n,
    deposit: 1_000_000n,
    mint: MINT,
    paidOut: 0n,
    payee: PAY_TO,
    settled: 0n,
    splits: [],
    status: "open",
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    ...overrides,
  };
}

describe("batch-settlement SVM scheme", () => {
  describe("server.parsePrice", () => {
    const server = new BatchServerScheme();

    it("parses dollar prices to 6-decimal atomic units", async () => {
      const result = await server.parsePrice("$0.001", SOLANA_MAINNET_CAIP2);
      expect(result.amount).toBe("1000");
      expect(result.asset).toBe(USDC_MAINNET_ADDRESS);
    });

    it("uses the devnet USDC mint on devnet", async () => {
      const result = await server.parsePrice("1.00", SOLANA_DEVNET_CAIP2);
      expect(result.amount).toBe("1000000");
      expect(result.asset).toBe(USDC_DEVNET_ADDRESS);
    });
  });

  describe("server.enhancePaymentRequirements", () => {
    it("folds the facilitator channel binding into extra", async () => {
      const server = new BatchServerScheme();
      const requirements = {
        amount: "1000",
        asset: MINT,
        extra: { custom: "value" },
        maxTimeoutSeconds: 300,
        network: SOLANA_DEVNET_CAIP2,
        payTo: PAY_TO,
        scheme: "batch-settlement",
      } as PaymentRequirements;

      const result = await server.enhancePaymentRequirements(
        requirements,
        {
          extra: {
            channelProgram: "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX",
            feePayer: "Op111",
            gracePeriodSeconds: 900,
            profiles: ["payment-channel"],
          },
          network: SOLANA_DEVNET_CAIP2,
          scheme: "batch-settlement",
          x402Version: 2,
        },
        [],
      );
      expect(result.extra).toMatchObject({
        channelProgram: "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX",
        custom: "value",
        feePayer: "Op111",
        gracePeriodSeconds: 900,
      });
    });
  });

  describe("type guards", () => {
    it("recognizes deposit / voucher / refund payloads", () => {
      const voucher: BatchVoucher = {
        channelId: PAY_TO,
        cumulativeAmount: "1000",
        expiresAt: FAR_FUTURE,
        signature: "sig",
        signer: PAY_TO,
      };
      expect(isBatchVoucher(voucher)).toBe(true);
      expect(isBatchVoucher({ channelId: 1 })).toBe(false);
      expect(isBatchPayload({ channelId: PAY_TO, type: "voucher", voucher })).toBe(true);
      expect(isBatchPayload({ channelConfig: {}, transaction: "tx", type: "deposit" })).toBe(true);
      expect(isBatchPayload({ channelId: PAY_TO, type: "refund" })).toBe(true);
      expect(isBatchPayload({ type: "nope" })).toBe(false);
      expect(isBatchPayload(null)).toBe(false);
    });
  });

  describe("client voucher signing (round-trip)", () => {
    it("signs a voucher the verifier accepts under the client key", async () => {
      const client = await generateKeyPairSigner();
      const channelId = (await generateKeyPairSigner()).address;
      const voucher = await signBatchVoucher(client, {
        channelId,
        cumulativeAmount: 5_000n,
        expiresAt: FAR_FUTURE,
      });
      expect(voucher.signer).toBe(client.address);
      expect(voucher.cumulativeAmount).toBe("5000");
      const ok = await verifyVoucherSignature({
        message: encodeVoucherMessageBytes({
          channelId,
          cumulativeAmount: 5_000n,
          expiresAt: BigInt(FAR_FUTURE),
        }),
        signatureBase58: voucher.signature,
        signerBase58: voucher.signer,
      });
      expect(ok).toBe(true);
    });

    it("BatchChannelTracker advances the cumulative monotonically", async () => {
      const client = await generateKeyPairSigner();
      const channelId = (await generateKeyPairSigner()).address;
      const tracker = new BatchChannelTracker(channelId, client, FAR_FUTURE);
      const v1 = await tracker.voucher(1_000n);
      const v2 = await tracker.voucher(1_500n);
      expect(v1.cumulativeAmount).toBe("1000");
      expect(v2.cumulativeAmount).toBe("2500");
      expect(tracker.cumulative).toBe(2_500n);
    });
  });

  describe("client.buildDepositPayload", () => {
    it("opens with the client as authorized signer and a first voucher", async () => {
      const client = await generateKeyPairSigner();
      const operator = await generateKeyPairSigner();
      const built = await buildDepositPayload({
        blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
        depositAmount: 1_000_000n,
        expiresAt: FAR_FUTURE,
        feePayer: operator.address,
        firstCharge: 1_000n,
        mint: MINT,
        payee: PAY_TO,
        payer: client,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });

      // Channel PDA is derived with the CLIENT as authorized signer.
      const derived = await findPaymentChannelPda({
        authorizedSigner: client.address,
        mint: MINT,
        payee: PAY_TO,
        payer: client.address,
        salt: BigInt(built.payload.channelConfig.salt),
      });
      expect(built.channelId).toBe(derived);
      expect(built.payload.type).toBe("deposit");
      expect(built.payload.channelConfig.authorizedSigner).toBe(client.address);
      expect(built.payload.voucher?.cumulativeAmount).toBe("1000");
      expect(built.payload.voucher?.signer).toBe(client.address);
    });
  });

  describe("buildSettleInstructions", () => {
    it("emits [ed25519_verify, settle] with the settle discriminator", async () => {
      const client = await generateKeyPairSigner();
      const channelId = (await generateKeyPairSigner()).address;
      const voucher = await signBatchVoucher(client, {
        channelId,
        cumulativeAmount: 2_000n,
        expiresAt: FAR_FUTURE,
      });
      const ixs = buildSettleInstructions({
        channelId,
        voucher: {
          authorizedSigner: client.address,
          cumulativeAmount: 2_000n,
          expiresAt: BigInt(FAR_FUTURE),
          signatureBase58: voucher.signature,
        },
      });
      expect(ixs).toHaveLength(2);
      // settle is the second instruction; its data is a single discriminator byte.
      const settle = ixs[1];
      expect(settle.data[0]).toBe(SETTLE_DISCRIMINATOR);
      expect(settle.accounts).toHaveLength(2);
    });
  });

  describe("acceptVoucher (off-chain)", () => {
    let client: Awaited<ReturnType<typeof generateKeyPairSigner>>;
    let channelId: string;
    let store: MemoryChannelStore;

    beforeAll(async () => {
      client = await generateKeyPairSigner();
      channelId = (await generateKeyPairSigner()).address;
    });

    const freshStore = async () => {
      const s = new MemoryChannelStore();
      await s.put(
        seedChannel({ authorizedSigner: client.address, channelId, payer: client.address }),
      );
      return s;
    };

    const accept = (
      s: MemoryChannelStore,
      cumulative: bigint,
      voucher: BatchVoucher,
      opts: {
        now?: number;
        perRequest?: bigint;
        minVoucherDelta?: bigint;
        minExpiryWindowSeconds?: number;
      } = {},
    ) =>
      acceptVoucher(s, {
        channelId,
        cumulativeAmount: cumulative,
        expiresAt: voucher.expiresAt,
        minExpiryWindowSeconds: opts.minExpiryWindowSeconds,
        minVoucherDelta: opts.minVoucherDelta,
        now: opts.now ?? 1_000,
        perRequest: opts.perRequest,
        signatureBase58: voucher.signature,
        signer: voucher.signer,
      });

    const sign = (cumulative: bigint, expiresAt = FAR_FUTURE) =>
      signBatchVoucher(client, { channelId, cumulativeAmount: cumulative, expiresAt });

    it("accepts an increasing voucher and reports the delta charged", async () => {
      store = await freshStore();
      const r1 = await accept(store, 1_000n, await sign(1_000n));
      expect(r1.ok && r1.charged).toBe(1_000n);
      const r2 = await accept(store, 2_500n, await sign(2_500n));
      expect(r2.ok && r2.charged).toBe(1_500n);
    });

    it("rejects a non-monotonic cumulative", async () => {
      const s = await freshStore();
      await accept(s, 2_000n, await sign(2_000n));
      const r = await accept(s, 1_000n, await sign(1_000n));
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe(BatchError.CUMULATIVE_BELOW_ACCEPTED);
    });

    it("rejects a cumulative exceeding the deposit", async () => {
      const s = await freshStore();
      const r = await accept(s, 2_000_000n, await sign(2_000_000n));
      expect(!r.ok && r.reason).toBe(BatchError.CUMULATIVE_EXCEEDS_DEPOSIT);
    });

    it("rejects an expired voucher", async () => {
      const s = await freshStore();
      const r = await accept(s, 1_000n, await sign(1_000n, 500), { now: 1_000 });
      expect(!r.ok && r.reason).toBe(BatchError.VOUCHER_EXPIRED);
    });

    it("rejects a voucher signed by a non-authorized signer", async () => {
      const s = await freshStore();
      const other = await generateKeyPairSigner();
      const voucher = await signBatchVoucher(other, {
        channelId,
        cumulativeAmount: 1_000n,
        expiresAt: FAR_FUTURE,
      });
      const r = await accept(s, 1_000n, voucher);
      expect(!r.ok && r.reason).toBe(BatchError.AUTHORIZED_SIGNER_MISMATCH);
    });

    it("rejects a tampered signature", async () => {
      const s = await freshStore();
      const voucher = await sign(1_000n);
      // Deterministically flip the last base58 char so the signature always
      // changes (a fixed replacement no-ops when the char already matches).
      const last = voucher.signature.slice(-1);
      const r = await accept(s, 1_000n, {
        ...voucher,
        signature: voucher.signature.slice(0, -1) + (last === "1" ? "2" : "1"),
      });
      expect(!r.ok && r.reason).toBe(BatchError.VOUCHER_SIGNATURE);
    });

    it("treats an exact replay (same cumulative + signature) as a no-op", async () => {
      const s = await freshStore();
      const voucher = await sign(1_000n);
      const first = await accept(s, 1_000n, voucher);
      expect(first.ok && first.charged).toBe(1_000n);
      expect(first.ok && first.replay).toBe(false);
      const replay = await accept(s, 1_000n, voucher);
      expect(replay.ok && replay.charged).toBe(0n);
      // An exact replay re-serves the cached response; it MUST NOT serve fresh.
      expect(replay.ok && replay.replay).toBe(true);
    });

    it("rejects a different signature at the same cumulative (no idempotent re-serve)", async () => {
      const s = await freshStore();
      await accept(s, 1_000n, await sign(1_000n));
      // Same cumulative, different (still-valid) signature: not the recorded
      // watermark signature, so it is treated as a non-monotonic voucher.
      const other = await sign(1_000n, FAR_FUTURE - 1);
      const r = await accept(s, 1_000n, other);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe(BatchError.CUMULATIVE_BELOW_ACCEPTED);
    });

    it("a genuine strict increment charges the delta, is not a replay, advances the watermark", async () => {
      const s = await freshStore();
      const first = await accept(s, 1_000n, await sign(1_000n), { perRequest: 1_000n });
      expect(first.ok && first.charged).toBe(1_000n);
      const second = await accept(s, 2_000n, await sign(2_000n), { perRequest: 1_000n });
      expect(second.ok && second.charged).toBe(1_000n);
      expect(second.ok && second.replay).toBe(false);
      expect(second.ok && second.state.cumulative).toBe(2_000n);
    });

    it("rejects an increment below the per-request floor", async () => {
      const s = await freshStore();
      await accept(s, 1_000n, await sign(1_000n), { perRequest: 1_000n });
      // +500 < perRequest 1_000 → rejected.
      const r = await accept(s, 1_500n, await sign(1_500n), { perRequest: 1_000n });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe(BatchError.CUMULATIVE_BELOW_PER_REQUEST);
    });

    it("accepts a never-expiring voucher (expiresAt === 0)", async () => {
      const s = await freshStore();
      const r = await accept(s, 1_000n, await sign(1_000n, 0), {
        now: 1_000,
        minExpiryWindowSeconds: 900,
      });
      expect(r.ok && r.charged).toBe(1_000n);
    });

    it("rejects a voucher that expires inside the settlement window", async () => {
      const s = await freshStore();
      const now = 1_000;
      const grace = 900;
      // expiresAt is in the future but within now + grace → too short to outlast
      // the async on-chain settlement.
      const r = await accept(s, 1_000n, await sign(1_000n, now + grace / 2), {
        now,
        minExpiryWindowSeconds: grace,
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe(BatchError.VOUCHER_EXPIRES_BEFORE_SETTLEMENT);
    });

    it("accepts a voucher that outlasts the settlement window", async () => {
      const s = await freshStore();
      const now = 1_000;
      const grace = 900;
      const r = await accept(s, 1_000n, await sign(1_000n, now + grace + 60), {
        now,
        minExpiryWindowSeconds: grace,
      });
      expect(r.ok && r.charged).toBe(1_000n);
    });

    it("rejects a voucher whose expiry is at or before now", async () => {
      const s = await freshStore();
      const r = await accept(s, 1_000n, await sign(1_000n, 500), {
        now: 1_000,
        minExpiryWindowSeconds: 900,
      });
      expect(r.ok).toBe(false);
      expect(!r.ok && r.reason).toBe(BatchError.VOUCHER_EXPIRED);
    });

    it("enforces minVoucherDelta", async () => {
      const s = await freshStore();
      await accept(s, 1_000n, await sign(1_000n), { minVoucherDelta: 500n });
      const r = await accept(s, 1_200n, await sign(1_200n), { minVoucherDelta: 500n });
      expect(!r.ok && r.reason).toBe(BatchError.CUMULATIVE_BELOW_MIN_DELTA);
    });

    it("enforces the per-request floor", async () => {
      const s = await freshStore();
      const r = await accept(s, 100n, await sign(100n), { perRequest: 1_000n });
      expect(!r.ok && r.reason).toBe(BatchError.CUMULATIVE_BELOW_PER_REQUEST);
    });

    it("rejects an unknown channel", async () => {
      const s = new MemoryChannelStore();
      const r = await accept(s, 1_000n, await sign(1_000n));
      expect(!r.ok && r.reason).toBe(BatchError.CHANNEL_NOT_FOUND);
    });

    it("rejects a closing channel", async () => {
      const s = await freshStore();
      await s.update(channelId, c => ({ ...c!, status: "closing" }));
      const r = await accept(s, 1_000n, await sign(1_000n));
      expect(!r.ok && r.reason).toBe(BatchError.CHANNEL_CLOSING);
    });
  });

  describe("verifyOpenTransaction (open-tx guard)", () => {
    it("rejects an open transaction that carries address-lookup tables", async () => {
      // The verifier validates accounts from the static keys; an ALT could hide
      // accounts and smuggle operator-as-authority/source/writable usage past
      // the fee-payer guard. An `open` needs only static accounts, so any ALT
      // must be rejected. Build a v0 compiled message, inject a non-empty
      // `addressTableLookups`, re-encode it, and wrap it into a wire
      // transaction the way the verifier ingests it.
      const feePayer = await generateKeyPairSigner();
      const lookupTable = (await generateKeyPairSigner()).address;
      const computeBudget = address("ComputeBudget111111111111111111111111111111");

      const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayer(feePayer.address, m),
        m =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n },
            m,
          ),
        m =>
          appendTransactionMessageInstructions(
            [
              {
                programAddress: computeBudget,
                accounts: [],
                data: new Uint8Array([2, 0, 0, 0, 0]),
              },
            ],
            m,
          ),
      );
      const compiled = compileTransaction(message);
      const decodedMessage = getCompiledTransactionMessageDecoder().decode(compiled.messageBytes);
      const withLookups = {
        ...decodedMessage,
        addressTableLookups: [
          { lookupTableAddress: lookupTable, readonlyIndexes: [1], writableIndexes: [0] },
        ],
      };
      const messageBytes = getCompiledTransactionMessageEncoder().encode(
        withLookups as Parameters<
          ReturnType<typeof getCompiledTransactionMessageEncoder>["encode"]
        >[0],
      );
      const wireTransaction = getBase64EncodedWireTransaction({
        messageBytes: messageBytes as typeof compiled.messageBytes,
        signatures: { [feePayer.address]: new Uint8Array(64) },
      });

      await expect(
        verifyOpenTransaction(wireTransaction, {
          authorizedSigner: feePayer.address,
          maxCap: 1_000_000n,
          mint: MINT,
          operator: feePayer.address,
          payee: PAY_TO,
        }),
      ).rejects.toThrow(/address-lookup tables are not permitted/);
    });
  });

  describe("facilitator", () => {
    it("getExtra advertises the operator, channel program, grace, profiles", async () => {
      const operator = await generateKeyPairSigner();
      const facilitator = new BatchFacilitatorScheme(operator, { gracePeriodSeconds: 900 });
      const extra = facilitator.getExtra(SOLANA_DEVNET_CAIP2);
      expect(extra?.feePayer).toBe(operator.address);
      expect(extra?.profiles).toEqual(["payment-channel"]);
      expect(extra?.gracePeriodSeconds).toBe(900);
      expect(typeof extra?.channelProgram).toBe("string");
    });

    it("verify accepts a steady-state voucher against a known channel", async () => {
      const operator = await generateKeyPairSigner();
      const client = await generateKeyPairSigner();
      const channelId = (await generateKeyPairSigner()).address;
      const store = new MemoryChannelStore();
      await store.put(
        seedChannel({ authorizedSigner: client.address, channelId, payer: client.address }),
      );
      const facilitator = new BatchFacilitatorScheme(operator, { store });

      const voucher = await signBatchVoucher(client, {
        channelId,
        cumulativeAmount: 1_000n,
        expiresAt: FAR_FUTURE,
      });
      const requirements: PaymentRequirements = {
        amount: "1000",
        asset: MINT,
        extra: { feePayer: operator.address },
        maxTimeoutSeconds: 300,
        network: SOLANA_DEVNET_CAIP2,
        payTo: PAY_TO,
        scheme: "batch-settlement",
      };
      const payload: PaymentPayload = {
        accepted: requirements,
        payload: { channelId, type: "voucher", voucher } as unknown as Record<string, unknown>,
        x402Version: 2,
      };
      const result = await facilitator.verify(payload, requirements);
      expect(result.isValid).toBe(true);
      expect((result.extra?.channelState as { settled: string }).settled).toBeDefined();
      expect(result.extra?.chargedAmount).toBe("1000");
    });

    it("verify rejects a voucher for an unknown channel", async () => {
      const operator = await generateKeyPairSigner();
      const client = await generateKeyPairSigner();
      const channelId = (await generateKeyPairSigner()).address;
      const facilitator = new BatchFacilitatorScheme(operator);
      const voucher = await signBatchVoucher(client, {
        channelId,
        cumulativeAmount: 1_000n,
        expiresAt: FAR_FUTURE,
      });
      const requirements: PaymentRequirements = {
        amount: "1000",
        asset: MINT,
        extra: { feePayer: operator.address },
        maxTimeoutSeconds: 300,
        network: SOLANA_DEVNET_CAIP2,
        payTo: PAY_TO,
        scheme: "batch-settlement",
      };
      const result = await facilitator.verify(
        {
          accepted: requirements,
          payload: { channelId, type: "voucher", voucher } as unknown as Record<string, unknown>,
          x402Version: 2,
        },
        requirements,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(BatchError.CHANNEL_NOT_FOUND);
    });

    it("verify rejects an unsupported payload shape", async () => {
      const operator = await generateKeyPairSigner();
      const facilitator = new BatchFacilitatorScheme(operator);
      const requirements: PaymentRequirements = {
        amount: "1000",
        asset: MINT,
        extra: { feePayer: operator.address },
        maxTimeoutSeconds: 300,
        network: SOLANA_DEVNET_CAIP2,
        payTo: PAY_TO,
        scheme: "batch-settlement",
      };
      const result = await facilitator.verify(
        { accepted: requirements, payload: { foo: "bar" }, x402Version: 2 },
        requirements,
      );
      expect(result.isValid).toBe(false);
      expect(result.invalidReason).toBe(BatchError.UNSUPPORTED_PAYLOAD);
    });

    it("settle of a voucher reports an off-chain charge with no transaction", async () => {
      const operator = await generateKeyPairSigner();
      const client = await generateKeyPairSigner();
      const channelId = (await generateKeyPairSigner()).address;
      const store = new MemoryChannelStore();
      await store.put(
        seedChannel({
          authorizedSigner: client.address,
          channelId,
          cumulative: 1_000n,
          payer: client.address,
        }),
      );
      const facilitator = new BatchFacilitatorScheme(operator, { store });

      const requirements: PaymentRequirements = {
        amount: "1000",
        asset: MINT,
        extra: { feePayer: operator.address },
        maxTimeoutSeconds: 300,
        network: SOLANA_DEVNET_CAIP2,
        payTo: PAY_TO,
        scheme: "batch-settlement",
      };
      const voucher: BatchVoucher = {
        channelId,
        cumulativeAmount: "1000",
        expiresAt: FAR_FUTURE,
        signature: "sig",
        signer: client.address,
      };
      const result = await facilitator.settle(
        {
          accepted: requirements,
          payload: { channelId, type: "voucher", voucher } as unknown as Record<string, unknown>,
          x402Version: 2,
        },
        requirements,
      );
      expect(result.success).toBe(true);
      expect(result.transaction).toBe("");
      expect(result.extra?.chargedAmount).toBe("1000");
    });
  });
});
