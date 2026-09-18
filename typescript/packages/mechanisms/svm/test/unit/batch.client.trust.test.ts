import { generateKeyPairSigner } from "@solana/kit";
import { fetchMint } from "@solana-program/token-2022";
import type { PaymentRequirements } from "@x402/core/types";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BatchSvmScheme } from "../../src/batch-settlement/client/scheme";
import {
  isServerSignedAccept,
  ServerSignedTrustPolicy,
} from "../../src/batch-settlement/client/trust";
import { BatchError } from "../../src/batch-settlement/errors";
import { SOLANA_DEVNET_CAIP2, TOKEN_PROGRAM_ADDRESS } from "../../src/constants";
import { USDC_DEVNET_ADDRESS, USDC_MAINNET_ADDRESS } from "../../src/defaultAssets";
import { signVoucher } from "../../src/payment-channels/voucher";
import { createRpcClient, resolveBlockhash, resolveOpenSlot } from "../../src/utils";

vi.mock("@solana-program/token-2022", async importOriginal => ({
  ...(await importOriginal<typeof import("@solana-program/token-2022")>()),
  fetchMint: vi.fn(),
}));

vi.mock("../../src/utils", async importOriginal => ({
  ...(await importOriginal<typeof import("../../src/utils")>()),
  createRpcClient: vi.fn(),
  resolveBlockhash: vi.fn(),
  resolveOpenSlot: vi.fn(),
}));

const NETWORK = SOLANA_DEVNET_CAIP2;
const ORIGIN = "https://api.example.test";
const OTHER_ORIGIN = "https://phishing.example.test";

let payer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let feePayer: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let operator: Awaited<ReturnType<typeof generateKeyPairSigner>>;
let otherOperator: Awaited<ReturnType<typeof generateKeyPairSigner>>;

beforeAll(async () => {
  [payer, feePayer, operator, otherOperator] = await Promise.all([
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
    generateKeyPairSigner(),
  ]);
});

beforeEach(() => {
  vi.mocked(fetchMint).mockResolvedValue({ programAddress: TOKEN_PROGRAM_ADDRESS } as never);
  vi.mocked(resolveBlockhash).mockResolvedValue({
    blockhash: USDC_MAINNET_ADDRESS,
    lastValidBlockHeight: 10n,
  });
  vi.mocked(resolveOpenSlot).mockResolvedValue(123n);
  vi.mocked(createRpcClient).mockReturnValue({
    getProgramAccounts: vi.fn(() => ({ send: vi.fn().mockResolvedValue([]) })),
  } as never);
});

function clientAccept(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    amount: "1000",
    asset: USDC_DEVNET_ADDRESS,
    extra: {
      feePayer: feePayer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      withdrawDelay: 900,
    },
    maxTimeoutSeconds: 300,
    network: NETWORK,
    payTo: USDC_MAINNET_ADDRESS,
    scheme: "batch-settlement",
    ...overrides,
  };
}

function serverAccept(
  operatorAddress = operator.address,
  extra: Record<string, unknown> = {},
): PaymentRequirements {
  return clientAccept({
    extra: {
      ...clientAccept().extra,
      operator: operatorAddress,
      voucherSigner: "server",
      ...extra,
    },
  });
}

function evmAccept(): PaymentRequirements {
  return {
    amount: "1000",
    asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra: {},
    maxTimeoutSeconds: 300,
    network: "eip155:84532",
    payTo: "0x0000000000000000000000000000000000000001",
    scheme: "batch-settlement",
  };
}

describe("server-signed trust policy", () => {
  it("rejects grants that name nothing, a zero cap, or a malformed origin", () => {
    expect(() => new ServerSignedTrustPolicy([{}])).toThrow(/origin, an operator, or both/);
    expect(() => new ServerSignedTrustPolicy([{ operator: "" }])).toThrow(/non-empty/);
    expect(() => new ServerSignedTrustPolicy([{ origin: ORIGIN, maxDeposit: "0" }])).toThrow(
      /positive/,
    );
    expect(() => new ServerSignedTrustPolicy([{ origin: "api.example.test" }])).toThrow(
      /absolute URL/,
    );
    expect(() => new ServerSignedTrustPolicy([{ origin: "ftp://api.example.test" }])).toThrow(
      /http or https/,
    );
    expect(isServerSignedAccept(serverAccept())).toBe(true);
    expect(isServerSignedAccept(clientAccept())).toBe(false);
  });

  it("drops untrusted server-signed accepts and keeps the client-signed fallback", () => {
    const policy = new ServerSignedTrustPolicy([{ origin: ORIGIN }]);
    const server = serverAccept();
    const client = clientAccept();
    const paymentRequired = { accepts: [server, client] };
    policy.authorize(paymentRequired, `${OTHER_ORIGIN}/v1/infer`);
    expect(paymentRequired.accepts).toEqual([client]);
    expect(policy.grantFor(server)).toBeUndefined();
  });

  it("refuses outright when every accept needs an untrusted operator", () => {
    const policy = new ServerSignedTrustPolicy([{ origin: ORIGIN }]);
    expect(() =>
      policy.authorize({ accepts: [serverAccept()] }, `${OTHER_ORIGIN}/v1/infer`),
    ).toThrow(new RegExp(`${OTHER_ORIGIN}.*${operator.address}.*Trust it explicitly`));
    // A 402 with no server-signed accepts is left exactly as it was.
    const untouched = { accepts: [clientAccept(), evmAccept()] };
    const before = [...untouched.accepts];
    policy.authorize(untouched, `${OTHER_ORIGIN}/v1/infer`);
    expect(untouched.accepts).toEqual(before);
  });

  it("uses the requested URL, never the 402 body, to decide the origin", () => {
    const policy = new ServerSignedTrustPolicy([{ origin: ORIGIN }]);
    const server = serverAccept(operator.address, { resource: ORIGIN });
    expect(() => policy.authorize({ accepts: [server] }, `${OTHER_ORIGIN}/x`)).toThrow(
      /Trust it explicitly/,
    );
    expect(() => policy.authorize({ accepts: [server] }, "not a url")).toThrow(/absolute URL/);
  });

  it("grants a trusted origin and prefers its server-signed accept on that network", () => {
    const policy = new ServerSignedTrustPolicy([{ origin: `${ORIGIN}/`, maxDeposit: 5_000n }]);
    const evm = evmAccept();
    const client = clientAccept();
    const server = serverAccept();
    const paymentRequired = { accepts: [evm, client, server] };
    policy.authorize(paymentRequired, `${ORIGIN}/v1/infer?x=1`);
    // The EVM accept keeps its place; the trusted server-signed accept moves
    // ahead of the same route's client-signed accept.
    expect(paymentRequired.accepts).toEqual([evm, server, client]);
    expect(policy.grantFor(server)).toEqual({ origin: ORIGIN, maxDeposit: 5_000n });
    // The grant is bound to the accept object the hook saw, not to the shape.
    expect(policy.grantFor(serverAccept())).toBeUndefined();
  });

  it("pins the operator an origin may advertise", () => {
    const policy = new ServerSignedTrustPolicy([{ origin: ORIGIN, operator: operator.address }]);
    const pinned = serverAccept();
    const swapped = serverAccept(otherOperator.address);
    const missing = clientAccept({
      extra: { ...clientAccept().extra, voucherSigner: "server" },
    });
    const paymentRequired = { accepts: [swapped, pinned, missing, clientAccept()] };
    policy.authorize(paymentRequired, `${ORIGIN}/v1`);
    expect(paymentRequired.accepts.map(a => a.extra?.operator)).toEqual([
      operator.address,
      undefined,
    ]);
  });

  it("trusts an operator key anywhere when the grant has no origin", () => {
    const policy = new ServerSignedTrustPolicy([{ operator: operator.address }]);
    expect(policy.grantFor(serverAccept())).toEqual({ operator: operator.address });
    expect(policy.grantFor(serverAccept(otherOperator.address))).toBeUndefined();
    const paymentRequired = { accepts: [serverAccept(otherOperator.address), serverAccept()] };
    policy.authorize(paymentRequired, `${OTHER_ORIGIN}/v1`);
    expect(paymentRequired.accepts.map(a => a.extra?.operator)).toEqual([operator.address]);
  });
});

describe("server-signed channels on the client scheme", () => {
  it("never opens a server-signed channel without a grant", async () => {
    const client = new BatchSvmScheme(payer, { discoverChannels: false });
    await expect(client.createPaymentPayload(2, serverAccept())).rejects.toThrow(
      /Trust it explicitly/,
    );
    const origins = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannels: { trust: [{ origin: ORIGIN }] },
    });
    // An origin grant needs the HTTP hook to have seen this request's URL.
    await expect(origins.createPaymentPayload(2, serverAccept())).rejects.toThrow(
      /Trust it explicitly/,
    );
  });

  it("opens through the payment-required hook for a trusted origin", async () => {
    const client = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannels: { trust: [{ origin: ORIGIN, operator: operator.address }] },
    });
    const server = serverAccept();
    const paymentRequired = { accepts: [server, clientAccept()] };
    await expect(
      client.paymentRequiredHook({ paymentRequired, requestUrl: `${ORIGIN}/v1/infer` }),
    ).resolves.toBeUndefined();
    expect(paymentRequired.accepts[0]).toBe(server);
    const payment = await client.createPaymentPayload(2, server);
    expect(payment.payload).toMatchObject({
      type: "deposit",
      channelConfig: { payerAuthorizer: operator.address, voucherSigner: "server" },
    });
  });

  it("caps the escrow at the grant, ignoring larger server hints and fixed deposits", async () => {
    const trust = { trust: [{ operator: operator.address, maxDeposit: "2500" }] };
    const hinted = serverAccept(operator.address, { minDeposit: "100000" });
    const client = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannels: trust,
    });
    await expect(client.createPaymentPayload(2, hinted)).resolves.toMatchObject({
      payload: { deposit: { amount: "2500" } },
    });
    const fixed = new BatchSvmScheme(payer, {
      depositAmount: 50_000n,
      discoverChannels: false,
      serverSignedChannels: trust,
    });
    await expect(fixed.createPaymentPayload(2, hinted)).resolves.toMatchObject({
      payload: { deposit: { amount: "2500" } },
    });
    // The first request alone would already exceed what the client is willing
    // to hand the operator.
    await expect(
      new BatchSvmScheme(payer, {
        discoverChannels: false,
        serverSignedChannels: trust,
      }).createPaymentPayload(2, { ...serverAccept(), amount: "3000" }),
    ).rejects.toThrow(/exceeds the remaining serverSignedChannels.trust maxDeposit/);
  });

  it("refuses a top-up that would push the escrow past the grant", async () => {
    const client = new BatchSvmScheme(payer, {
      discoverChannels: false,
      serverSignedChannels: { trust: [{ operator: operator.address, maxDeposit: 2_500n }] },
    });
    const accept = serverAccept();
    const opened = await client.createPaymentPayload(2, accept);
    const channelId = opened.payload.authorization!.channelId;
    const settle = async (payment: typeof opened, cumulative: bigint) =>
      client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...payment },
        requirements: accept,
        settleResponse: {
          extra: {
            channelState: { chargedCumulativeAmount: cumulative.toString() },
            commitmentId: `${channelId}:${cumulative}`,
            voucher: {
              channelId,
              expiresAt: 0,
              maxClaimableAmount: cumulative.toString(),
              signature: await signVoucher(operator, {
                channelId,
                cumulativeAmount: cumulative,
                expiresAt: 0n,
              }),
            },
          },
          success: true,
        },
      } as never);
    await settle(opened, 1_000n);
    await settle(await client.createPaymentPayload(2, accept), 2_000n);
    // 2000 charged of 2500 escrowed; the next 1000 ceiling needs 500 more,
    // and the grant has no room left.
    await expect(client.createPaymentPayload(2, accept)).rejects.toThrow(
      /2500 total, 2500 already escrowed/,
    );
  });

  it("adopts a corrective 402 only up to what this client authorized", async () => {
    const trust = { trust: [{ operator: operator.address }] };
    const accept = serverAccept();
    const run = async (correctiveCumulative: bigint) => {
      const client = new BatchSvmScheme(payer, {
        depositAmount: 10_000n,
        discoverChannels: false,
        serverSignedChannels: trust,
      });
      const opened = await client.createPaymentPayload(2, accept);
      const channelId = opened.payload.authorization!.channelId;
      const sign = async (cumulative: bigint) =>
        signVoucher(operator, { channelId, cumulativeAmount: cumulative, expiresAt: 0n });
      await client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...opened },
        requirements: accept,
        settleResponse: {
          extra: {
            channelState: { chargedCumulativeAmount: "1000" },
            commitmentId: `${channelId}:1000`,
            voucher: {
              channelId,
              expiresAt: 0,
              maxClaimableAmount: "1000",
              signature: await sign(1_000n),
            },
          },
          success: true,
        },
      } as never);
      const next = await client.createPaymentPayload(2, accept);
      const recovered = await client.schemeHooks.onPaymentResponse!({
        paymentPayload: { accepted: accept, ...next },
        requirements: accept,
        settleResponse: { success: false, errorReason: BatchError.CUMULATIVE_AMOUNT_MISMATCH },
        paymentRequired: {
          error: BatchError.CUMULATIVE_AMOUNT_MISMATCH,
          accepts: [
            {
              ...accept,
              extra: {
                ...accept.extra,
                channelState: {
                  balance: "10000",
                  channelId,
                  chargedCumulativeAmount: correctiveCumulative.toString(),
                  totalClaimed: "0",
                  withdrawRequestedAt: 0,
                },
                voucherState: {
                  expiresAt: 0,
                  signature: await sign(correctiveCumulative),
                  signedMaxClaimable: correctiveCumulative.toString(),
                },
              },
            },
          ],
        },
      } as never);
      return recovered;
    };
    // Confirmed 1000 plus one unresolved 1000 ceiling: 2000 is the most the
    // operator can legitimately say it charged.
    await expect(run(2_000n)).resolves.toEqual({ recovered: true });
    // A validly operator-signed jump to 5000 is refused; the signature is the
    // operator's own and proves nothing about what the client authorized.
    await expect(run(5_000n)).resolves.toBeUndefined();
  });
});
