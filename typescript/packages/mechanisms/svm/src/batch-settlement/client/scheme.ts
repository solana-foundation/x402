import { type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { fetchMint, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";

import { parseU64 } from "../../payment-channels/open";
import type { ClientSvmConfig } from "../../signer";
import { createRpcClient, resolveBlockhash } from "../../utils";
import { BATCH_SETTLEMENT_SCHEME, type BatchSplit } from "../types";
import { type BatchClientSigner, BatchChannelTracker, buildDepositPayload } from "./channel";

/** A reused channel and the deposit ceiling it was opened with. */
interface OpenChannel {
  tracker: BatchChannelTracker;
  deposit: bigint;
}

/**
 * SVM client for the `batch-settlement` scheme (payment-channel profile).
 *
 * Holds a per-route channel: the first paid request to a route opens a channel
 * (a `deposit` payload carrying the client-signed `open` + first cumulative
 * voucher); subsequent requests reuse the channel and emit `voucher` payloads,
 * advancing the cumulative by the per-request `amount`. When a channel's
 * remaining balance can no longer cover the next charge, a fresh channel is
 * opened. The client is the channel's `authorizedSigner` and signs every
 * voucher itself.
 *
 * State is held in-memory on the instance; reuse the same instance across
 * requests to a route to amortize on-chain settlement. This is a reference
 * client — durable channel persistence and the corrective-402 resync of the
 * spec are left to integrators.
 */
export class BatchSvmScheme implements SchemeNetworkClient {
  readonly scheme = BATCH_SETTLEMENT_SCHEME;
  private readonly channels = new Map<string, OpenChannel>();

  /**
   * Create a batch-settlement client.
   *
   * @param signer - The payer / client signer (also the channel authorized signer)
   * @param config - Optional configuration with a custom RPC URL
   */
  constructor(
    private readonly signer: BatchClientSigner,
    private readonly config?: ClientSvmConfig,
  ) {}

  /**
   * Create the next `batch-settlement` payload for a route: a `deposit` when no
   * usable channel exists yet, otherwise a steady-state `voucher`.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements (`amount` = per-request price)
   * @returns The x402 version and the scheme-specific payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const extra = paymentRequirements.extra ?? {};
    const feePayer = extra.feePayer as string | undefined;
    if (!feePayer) {
      throw new Error(
        "feePayer is required in paymentRequirements.extra for the batch-settlement scheme",
      );
    }

    const charge = parseU64(paymentRequirements.amount, "amount");
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + paymentRequirements.maxTimeoutSeconds;

    const key = this.channelKey(paymentRequirements, feePayer);
    const existing = this.channels.get(key);
    if (existing && existing.tracker.cumulative + charge <= existing.deposit) {
      const voucher = await existing.tracker.voucher(charge, expiresAt);
      return {
        x402Version,
        payload: { channelId: existing.tracker.channelId, type: "voucher", voucher },
      };
    }

    // Open a new channel: deposit the suggested/minimum (or the single charge).
    const deposit = this.depositAmount(extra, charge);
    const tokenProgram = await this.resolveTokenProgram(paymentRequirements);
    const rpc = createRpcClient(paymentRequirements.network, this.config?.rpcUrl);
    const latestBlockhash = await resolveBlockhash(rpc, paymentRequirements);

    const built = await buildDepositPayload({
      blockhash: {
        blockhash: latestBlockhash.blockhash,
        lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      },
      depositAmount: deposit,
      distributionSplits: extra.distributionSplits as BatchSplit[] | undefined,
      expiresAt,
      feePayer,
      firstCharge: charge,
      gracePeriodSeconds: extra.gracePeriodSeconds as number | undefined,
      mint: paymentRequirements.asset,
      payee: paymentRequirements.payTo,
      payer: this.signer,
      programId: extra.channelProgram as string | undefined,
      tokenProgram,
    });

    this.channels.set(key, { deposit, tracker: built.tracker });
    return { x402Version, payload: built.payload };
  }

  /**
   * Per-route channel cache key.
   *
   * @param requirements - The payment requirements
   * @param feePayer - The operator key
   * @returns A stable cache key
   */
  private channelKey(requirements: PaymentRequirements, feePayer: string): string {
    return `${requirements.network}:${requirements.asset}:${requirements.payTo}:${feePayer}`;
  }

  /**
   * Pick the deposit ceiling: the server's suggestion or minimum, else the
   * single per-request charge (degenerate one-shot channel).
   *
   * @param extra - The requirement extra
   * @param charge - The per-request charge
   * @returns The deposit amount (base units)
   */
  private depositAmount(extra: Record<string, unknown>, charge: bigint): bigint {
    const suggested = extra.suggestedDeposit as string | undefined;
    const minimum = extra.minimumDeposit as string | undefined;
    const chosen = suggested ?? minimum;
    if (chosen === undefined) return charge;
    const deposit = parseU64(chosen, "deposit");
    return deposit < charge ? charge : deposit;
  }

  /**
   * Resolve the token program: prefer the requirement's hint, else read the mint.
   *
   * @param requirements - The payment requirements
   * @returns The token program id (base58)
   */
  private async resolveTokenProgram(requirements: PaymentRequirements): Promise<string> {
    const hint = requirements.extra?.tokenProgram as string | undefined;
    if (hint) return hint;
    const rpc = createRpcClient(requirements.network, this.config?.rpcUrl);
    const mint = await fetchMint(rpc, requirements.asset as Address);
    const programAddress = mint.programAddress.toString();
    if (
      programAddress !== TOKEN_PROGRAM_ADDRESS.toString() &&
      programAddress !== TOKEN_2022_PROGRAM_ADDRESS.toString()
    ) {
      throw new Error("Asset was not created by a known token program");
    }
    return programAddress;
  }
}
