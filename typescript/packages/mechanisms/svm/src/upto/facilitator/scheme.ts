import { type Address, address } from "@solana/kit";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import {
  buildDistributeInstruction,
  buildSettleAndFinalizeInstructions,
  type ServerInstruction,
} from "../../payment-channels/onchain";
import { verifyOpenTransaction } from "../../payment-channels/open";
import { isUptoSvmPayload, type UptoSvmPayloadV2 } from "../../types";
import { createRpcClient, getStablecoinTokenProgram } from "../../utils";
import {
  broadcastOpen,
  channelExists,
  type OperatorSigner,
  signVoucher,
  submitSettle,
} from "./channel";

/** Scheme-specific error returned when the settlement amount exceeds the ceiling. */
export const ERR_SETTLEMENT_EXCEEDS_AMOUNT = "invalid_upto_svm_payload_settlement_exceeds_amount";

/** Optional configuration for the upto SVM facilitator. */
export interface UptoSvmFacilitatorConfig {
  /** Custom RPC URL (per-network defaults are used when omitted). */
  rpcUrl?: string;
}

/**
 * SVM facilitator for the `upto` payment scheme (payment-channel profile).
 *
 * `verify` validates the client authorization and broadcasts the channel `open`
 * (escrowing the ceiling before the resource is served); `settle` signs a single
 * operator voucher for the actual metered amount (`actual ≤ max`), then
 * `settle_and_finalize` + `distribute`, refunding the remainder to the payer.
 *
 * Unlike the exact scheme's minimal `FacilitatorSvmSigner`, this facilitator
 * needs an operator that can sign raw messages (the voucher) and access the RPC
 * (open broadcast + channel reads), so it takes a `TransactionSigner &
 * MessagePartialSigner` directly.
 */
export class UptoSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "upto";
  readonly caipFamily = "solana:*";

  /**
   * Create the upto SVM facilitator.
   *
   * @param operator - The operator signer: channel authorized signer, fee payer, and voucher signer
   * @param config - Optional RPC configuration
   */
  constructor(
    private readonly operator: OperatorSigner,
    private readonly config?: UptoSvmFacilitatorConfig,
  ) {}

  /**
   * Advertise the operator as both the facilitator binding and the fee payer.
   *
   * @param _ - The network identifier (unused)
   * @returns Extra metadata folded into the requirement's `extra`
   */
  getExtra(_: Network): Record<string, unknown> | undefined {
    // `feePayer` + `profiles` per scheme_upto_svm.md §4.1. `feePayer` is the
    // operator key that sponsors fees (co-signs the open) and settles.
    return {
      feePayer: this.operator.address,
      profiles: ["payment-channel"],
    };
  }

  /**
   * The operator signer addresses.
   *
   * @param _ - The network identifier (unused)
   * @returns The operator address
   */
  getSigners(_: string): string[] {
    return [this.operator.address];
  }

  /**
   * Verify the authorization and broadcast the channel open (idempotently).
   *
   * `requirements.amount` is treated as the authorized ceiling here.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = ceiling)
   * @returns The verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return { isValid: false, invalidReason: "unsupported_payload_type", payer: "" };
    }
    const p: UptoSvmPayloadV2 = raw;

    if (payload.accepted.scheme !== "upto" || requirements.scheme !== "upto") {
      return { isValid: false, invalidReason: "unsupported_scheme", payer: p.from };
    }
    if (payload.accepted.network !== requirements.network) {
      return { isValid: false, invalidReason: "network_mismatch", payer: p.from };
    }

    const operatorAddr = this.operator.address;
    if (requirements.extra?.feePayer !== operatorAddr) {
      return { isValid: false, invalidReason: "facilitator_mismatch", payer: p.from };
    }
    // This reference implementation is self-facilitating: the operator settles
    // and finalizes, and the program requires the `settle_and_finalize` merchant
    // to equal `channel.payee`. So the recipient must be the operator. A separate
    // facilitator (payTo != operator) needs the distribution-split flow and is
    // not supported here.
    if (requirements.payTo !== operatorAddr) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_recipient_not_operator",
        payer: p.from,
      };
    }
    if (p.authorizedSigner !== operatorAddr) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_authorized_signer",
        payer: p.from,
      };
    }

    // Ceiling: the signed maxAmount must equal the verification-phase amount.
    let maxAmount: bigint;
    let deposit: bigint;
    try {
      maxAmount = BigInt(p.maxAmount);
      deposit = BigInt(p.deposit);
    } catch {
      return { isValid: false, invalidReason: "invalid_upto_svm_payload_amount", payer: p.from };
    }
    if (maxAmount !== BigInt(requirements.amount)) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_amount_mismatch",
        payer: p.from,
      };
    }
    if (deposit !== maxAmount) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_deposit_not_ceiling",
        payer: p.from,
      };
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < p.validAfter) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_not_yet_active",
        payer: p.from,
      };
    }
    if (now > p.expiresAt) {
      return { isValid: false, invalidReason: "invalid_upto_svm_payload_expired", payer: p.from };
    }

    // Validate the open instruction against the pinned requirements.
    try {
      const open = await verifyOpenTransaction(p.openTransaction, {
        authorizedSigner: operatorAddr,
        operator: operatorAddr,
        maxCap: maxAmount,
        mint: requirements.asset,
        payee: requirements.payTo,
        programId: requirements.extra?.channelProgram as string | undefined,
      });
      // Bind the channel payer to `payload.from`: settlement builds the
      // distribute (refund) instruction from `p.from`, so a mismatch with the
      // open transaction's payer would make settlement fail on-chain.
      if (open.payer !== p.from) {
        return {
          isValid: false,
          invalidReason: "invalid_upto_svm_payload_payer_mismatch",
          invalidMessage: `open payer ${open.payer} != payload.from ${p.from}`,
          payer: p.from,
        };
      }
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "invalid_upto_svm_payload_open_transaction",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    // Escrow the ceiling before the resource is served: broadcast the open
    // (idempotent — skip when the channel already exists).
    try {
      const rpc = createRpcClient(requirements.network, this.config?.rpcUrl);
      if (!(await channelExists(rpc, p.channelId))) {
        await broadcastOpen(this.operator, rpc, p.openTransaction);
      }
    } catch (error) {
      return {
        isValid: false,
        invalidReason: "upto_channel_open_failed",
        invalidMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }

    return { isValid: true, invalidReason: undefined, payer: p.from };
  }

  /**
   * Settle the actual metered amount (`requirements.amount`) against the open
   * channel: operator voucher + settle_and_finalize + distribute, refunding the
   * remainder. `actual === 0` still finalizes (full refund).
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements (amount = actual charge)
   * @returns The settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const raw = payload.payload as Record<string, unknown>;
    if (!isUptoSvmPayload(raw)) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "unsupported_payload_type",
        payer: "",
      };
    }
    const p: UptoSvmPayloadV2 = raw;
    const maxAmount = BigInt(p.maxAmount);

    // Enforce actual ≤ ceiling first, against the signed `maxAmount` (never the
    // settlement-phase `amount`). Checked before any RPC work.
    let actual: bigint;
    try {
      actual = BigInt(requirements.amount);
    } catch {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "invalid_upto_svm_payload_amount",
        payer: p.from,
      };
    }
    if (actual > maxAmount) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: ERR_SETTLEMENT_EXCEEDS_AMOUNT,
        payer: p.from,
      };
    }

    // Re-verify against the signed ceiling (not the actual amount). This also
    // ensures the channel is open before we settle.
    const verifyResult = await this.verify(payload, { ...requirements, amount: p.maxAmount });
    if (!verifyResult.isValid) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: verifyResult.invalidReason ?? "verification_failed",
        errorMessage: verifyResult.invalidMessage,
        payer: p.from,
      };
    }

    try {
      const programIdStr = requirements.extra?.channelProgram as string | undefined;
      const programId: Address | undefined = programIdStr ? address(programIdStr) : undefined;
      const tokenProgram =
        (requirements.extra?.tokenProgram as string | undefined) ??
        getStablecoinTokenProgram(requirements.asset, requirements.network);

      const settle = buildSettleAndFinalizeInstructions({
        channelId: p.channelId,
        merchantSigner: this.operator,
        programId,
        voucher:
          actual > 0n
            ? {
                authorizedSigner: this.operator.address,
                cumulativeAmount: actual,
                expiresAt: BigInt(p.expiresAt),
                signatureBase58: await signVoucher(this.operator, {
                  channelId: p.channelId,
                  cumulativeAmount: actual,
                  expiresAt: BigInt(p.expiresAt),
                }),
              }
            : undefined,
      });

      const distribute = await buildDistributeInstruction({
        channelId: p.channelId,
        mint: requirements.asset,
        payee: requirements.payTo,
        payer: p.from,
        rentPayer: this.operator.address,
        programId,
        splits: [],
        tokenProgram,
      });

      const instructions: ServerInstruction[] = [...settle, distribute];
      const rpc = createRpcClient(requirements.network, this.config?.rpcUrl);
      const signature = await submitSettle(this.operator, rpc, instructions);

      return {
        success: true,
        transaction: signature,
        network: payload.accepted.network,
        amount: actual.toString(),
        payer: p.from,
      };
    } catch (error) {
      return {
        success: false,
        network: payload.accepted.network,
        transaction: "",
        errorReason: "transaction_failed",
        errorMessage: error instanceof Error ? error.message : String(error),
        payer: p.from,
      };
    }
  }
}
