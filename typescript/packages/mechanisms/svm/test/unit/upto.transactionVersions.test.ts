/**
 * Transaction message version negotiation for `upto` and the shared
 * payment-channels open transaction.
 *
 * The `@solana/kit` release resolved in this workspace refuses to decode a
 * transaction v1 wire payload, so the verifier gate is exercised by
 * overriding the compiled message decoder's reported `version`.
 */
import {
  generateKeyPairSigner,
  getBase64Codec,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";
import {
  buildOpenPaymentChannelTransaction,
  verifyOpenTransaction,
} from "../../src/payment-channels/open";
import { resolveTransactionVersion } from "../../src/utils";

/**
 * When set, every compiled message decoded through `@solana/kit` reports this
 * version instead of the one on the wire.
 */
let reportedVersionOverride: number | string | undefined;

vi.mock("@solana/kit", async importOriginal => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...actual,
    getCompiledTransactionMessageDecoder: () => {
      const real = actual.getCompiledTransactionMessageDecoder();
      return {
        ...real,
        decode: (bytes: Uint8Array, offset?: number) => {
          const compiled = real.decode(bytes, offset);
          return reportedVersionOverride === undefined
            ? compiled
            : { ...compiled, version: reportedVersionOverride };
        },
        read: (bytes: Uint8Array, offset: number) => {
          const [compiled, next] = real.read(bytes, offset);
          return [
            reportedVersionOverride === undefined
              ? compiled
              : { ...compiled, version: reportedVersionOverride },
            next,
          ];
        },
      };
    },
  };
});

const DUMMY_BLOCKHASH = USDC_DEVNET_ADDRESS;

function wireVersion(transactionBase64: string): number | string {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(transactionBase64));
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes).version;
}

async function openTransaction() {
  const payer = await generateKeyPairSigner();
  const feePayer = await generateKeyPairSigner();
  const receiverAuthorizer = await generateKeyPairSigner();
  const open = await buildOpenPaymentChannelTransaction({
    authorizedSigner: receiverAuthorizer.address,
    blockhash: { blockhash: DUMMY_BLOCKHASH, lastValidBlockHeight: 0n },
    deposit: 1_000_000n,
    feePayer: feePayer.address,
    gracePeriod: 900,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: 123_456_789n,
    payee: receiverAuthorizer.address,
    payer,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    transactionVersion: resolveTransactionVersion({ transactionVersions: [0] }),
  });
  const expected = {
    authorizedSigner: receiverAuthorizer.address,
    feePayer: feePayer.address,
    from: payer.address,
    maxCap: 1_000_000n,
    mint: USDC_DEVNET_ADDRESS,
    openSlot: 123_456_789n,
    payee: receiverAuthorizer.address,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
    withdrawDelay: 900,
  };
  return { open, expected };
}

afterEach(() => {
  reportedVersionOverride = undefined;
});

describe("payment-channels open builder", () => {
  it("builds a version 0 open transaction", async () => {
    const { open } = await openTransaction();
    expect(wireVersion(open.transaction)).toBe(0);
  });
});

describe("verifyOpenTransaction version gate", () => {
  it("rejects an unmodelled message version before layout checks", async () => {
    const { open, expected } = await openTransaction();

    reportedVersionOverride = 1;
    await expect(verifyOpenTransaction(open.transaction, expected)).rejects.toThrow(
      /^unsupported_transaction_version/,
    );

    reportedVersionOverride = undefined;
    await expect(verifyOpenTransaction(open.transaction, expected)).resolves.toMatchObject({
      channelId: open.channelId,
    });
  });
});
