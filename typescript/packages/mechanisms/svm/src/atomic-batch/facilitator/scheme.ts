import { findAssociatedTokenPda } from "@solana-program/token-2022";
import {
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  verifySignature,
  type Address,
  type Transaction,
} from "@solana/kit";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { TOKEN_PROGRAM_ADDRESS } from "../../constants";
import { getCachedMintMetadata, type MintMetadataCache } from "../../mint-cache";
import { SettlementCache } from "../../settlement-cache";
import type { FacilitatorSvmSigner } from "../../signer";
import type { AtomicBatchSvmPayloadV2 } from "../../types";
import {
  createRpcClient,
  decodeTransactionFromPayload,
  normalizeNetwork,
  transactionMessageHash,
} from "../../utils";
import { parseAtomicBatchItems } from "../shared";
import * as Errors from "./errors";

const compiledMessageDecoder = getCompiledTransactionMessageDecoder();
const addressEncoder = getAddressEncoder();
const base58Decoder = getBase58Decoder();
const base64Encoder = getBase64Encoder();

/** SPL Token `TransferChecked` instruction discriminant. */
const TRANSFER_CHECKED_DISCRIMINANT = 12;
/** SPL Token account data length in bytes. */
const TOKEN_ACCOUNT_LENGTH = 165;

/**
 * Configuration options for the atomic-batch SVM facilitator scheme.
 */
export type AtomicBatchSvmSchemeOptions = {
  /**
   * RPC endpoint used for on-chain reads (mint metadata, token account
   * ownership). When omitted, the default public RPC for the network is
   * used — production facilitators should always set this.
   */
  rpcUrl?: string;
};

/**
 * SVM facilitator implementation for the Atomic Batch payment scheme.
 *
 * The payer is fee payer and sole signer; the facilitator adds no
 * signature and never holds funds. Verification re-derives every property
 * from the signed transaction bytes and the itemized requirements:
 * exactly one valid signature, a strict `TransferChecked`-only
 * instruction allowlist, and per-item asset / recipient / amount matching
 * including on-chain token-account ownership. Settlement broadcasts the
 * transaction unchanged, guarded by a message-hash settlement cache
 * against duplicates.
 */
export class AtomicBatchSvmScheme implements SchemeNetworkFacilitator {
  readonly scheme = "atomic-batch";
  readonly caipFamily = "solana:*";

  private readonly settlementCache: SettlementCache;
  private readonly mintCache: MintMetadataCache = new Map();

  /**
   * Creates a new AtomicBatchSvmScheme instance.
   *
   * @param signer - The SVM signer used to relay (broadcast) settled transactions
   * @param settlementCache - Optional shared settlement cache (one is created if omitted)
   * @param options - Optional configuration
   */
  constructor(
    private readonly signer: FacilitatorSvmSigner,
    settlementCache?: SettlementCache,
    private readonly options?: AtomicBatchSvmSchemeOptions,
  ) {
    this.settlementCache = settlementCache ?? new SettlementCache();
  }

  /**
   * Get mechanism-specific extra data for the supported kinds endpoint.
   * Atomic-batch facilitators advertise nothing extra: the payer pays
   * transaction fees, so there is no fee payer to announce.
   *
   * @param _network - The network identifier (unused)
   * @returns undefined
   */
  getExtra(_network: Network): Record<string, unknown> | undefined {
    void _network;
    return undefined;
  }

  /**
   * Get signer addresses used by this facilitator.
   * The facilitator holds no signing authority in this scheme — it never
   * signs batch transactions — so this is always empty.
   *
   * @param _network - The network identifier (unused)
   * @returns An empty array
   */
  getSigners(_network: string): string[] {
    void _network;
    return [];
  }

  /**
   * Verifies an atomic-batch payment payload.
   *
   * @param payload - The payment payload to verify
   * @param requirements - The payment requirements, including `extra.items`
   * @returns Promise resolving to the verification response
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    if (requirements.scheme !== this.scheme) {
      return { isValid: false, invalidReason: Errors.ErrUnsupportedScheme };
    }
    try {
      normalizeNetwork(requirements.network);
    } catch {
      return { isValid: false, invalidReason: Errors.ErrUnsupportedNetwork };
    }

    const parsed = parseAtomicBatchItems(requirements);
    if (!parsed.ok) {
      return {
        isValid: false,
        invalidReason:
          parsed.reason === "missing"
            ? Errors.ErrMissingItems
            : parsed.reason === "sum_mismatch"
              ? Errors.ErrAmountSumMismatch
              : Errors.ErrInvalidItems,
      };
    }

    const batchPayload = payload.payload as Partial<AtomicBatchSvmPayloadV2> | undefined;
    if (!batchPayload || typeof batchPayload.transaction !== "string") {
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadTransaction };
    }

    let transaction: Transaction;
    try {
      transaction = decodeTransactionFromPayload({ transaction: batchPayload.transaction });
    } catch {
      return { isValid: false, invalidReason: Errors.ErrTransactionCouldNotBeDecoded };
    }

    const compiled = compiledMessageDecoder.decode(transaction.messageBytes);
    const staticAccounts = compiled.staticAccounts ?? [];
    const numSigners = compiled.header.numSignerAccounts;
    if (numSigners > 1) {
      return { isValid: false, invalidReason: Errors.ErrExcessiveSigners };
    }
    if (numSigners < 1 || staticAccounts.length === 0) {
      return { isValid: false, invalidReason: Errors.ErrMissingSignatures };
    }

    const payer = staticAccounts[0].toString();
    const invalid = (invalidReason: string): VerifyResponse => ({
      isValid: false,
      invalidReason,
      payer,
    });

    const signature = transaction.signatures[payer as Address];
    if (!signature || signature.length !== 64) {
      return invalid(Errors.ErrMissingSignatures);
    }
    if (!(await verifyEd25519(payer, signature, transaction.messageBytes))) {
      return invalid(Errors.ErrSignatureInvalid);
    }

    const instructions = compiled.instructions ?? [];
    if (instructions.length !== parsed.items.length) {
      return invalid(Errors.ErrItemCountMismatch);
    }

    const rpc = createRpcClient(requirements.network, this.options?.rpcUrl);
    let mintDecimals: number;
    try {
      const mintMetadata = await getCachedMintMetadata(
        rpc,
        requirements.network,
        requirements.asset as Address,
        this.mintCache,
      );
      if (mintMetadata.programAddress.toString() !== TOKEN_PROGRAM_ADDRESS) {
        return invalid(Errors.ErrWrongAsset);
      }
      mintDecimals = mintMetadata.decimals;
    } catch {
      return invalid(Errors.ErrWrongAsset);
    }

    const seen = new Set<string>();
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      const item = parsed.items[i];

      const program = staticAccounts[ix.programAddressIndex]?.toString();
      if (program !== TOKEN_PROGRAM_ADDRESS) {
        return invalid(Errors.ErrInvalidBatch);
      }
      const data = ix.data;
      if (!data || data.length !== 10 || data[0] !== TRANSFER_CHECKED_DISCRIMINANT) {
        return invalid(Errors.ErrInvalidBatch);
      }
      const accountIndices = ix.accountIndices ?? [];
      if (accountIndices.length < 4) {
        return invalid(Errors.ErrInvalidBatch);
      }
      const [sourceIndex, mintIndex, destinationIndex, authorityIndex] = accountIndices;

      if (staticAccounts[mintIndex]?.toString() !== requirements.asset) {
        return invalid(Errors.ErrWrongAsset);
      }
      if (authorityIndex !== 0) {
        return invalid(Errors.ErrAuthorityNotPayer);
      }
      const amount = new DataView(data.buffer, data.byteOffset + 1, 8).getBigUint64(0, true);
      if (data[9] !== mintDecimals) {
        return invalid(Errors.ErrWrongDecimals);
      }
      if (amount < BigInt(item.amount)) {
        return invalid(Errors.ErrInsufficientAmount);
      }

      const destination = staticAccounts[destinationIndex]?.toString();
      if (!destination) {
        return invalid(Errors.ErrInvalidBatch);
      }
      const [expectedDestination] = await findAssociatedTokenPda({
        mint: requirements.asset as Address,
        owner: item.payTo as Address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS as Address,
      });
      if (destination !== expectedDestination.toString()) {
        return invalid(Errors.ErrDestinationMismatch);
      }
      const duplicateKey = `${destination}:${amount.toString()}`;
      if (seen.has(duplicateKey)) {
        return invalid(Errors.ErrDuplicateItem);
      }
      seen.add(duplicateKey);

      const source = staticAccounts[sourceIndex]?.toString();
      if (!source) {
        return invalid(Errors.ErrInvalidBatch);
      }
      const destinationInfo = await this.readTokenAccount(rpc, destination);
      if (
        !destinationInfo ||
        destinationInfo.mint !== requirements.asset ||
        destinationInfo.owner !== item.payTo
      ) {
        return invalid(Errors.ErrWrongRecipient);
      }
      const sourceInfo = await this.readTokenAccount(rpc, source);
      if (!sourceInfo || sourceInfo.mint !== requirements.asset || sourceInfo.owner !== payer) {
        return invalid(Errors.ErrSourceMismatch);
      }
    }

    // Simulation confirms the batch executes as built (balances cover the
    // total) and that the blockhash is still live. Signature verification
    // was already done locally above; the signer simulates with it off.
    try {
      await this.signer.simulateTransaction(batchPayload.transaction, requirements.network);
    } catch {
      return invalid(Errors.ErrSimulationFailed);
    }

    return { isValid: true, payer };
  }

  /**
   * Settles an atomic-batch payment by broadcasting the client's
   * fully-signed transaction unchanged.
   *
   * @param payload - The payment payload to settle
   * @param requirements - The payment requirements, including `extra.items`
   * @returns Promise resolving to the settlement response
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const batchPayload = payload.payload as Partial<AtomicBatchSvmPayloadV2> | undefined;

    // Duplicate protection keyed on the message hash, claimed
    // synchronously before any async work (the pattern the exact SVM
    // facilitator uses) so concurrent settles of the same batch are
    // caught here.
    let txKey: string | undefined;
    if (batchPayload && typeof batchPayload.transaction === "string") {
      try {
        txKey = transactionMessageHash(
          decodeTransactionFromPayload({ transaction: batchPayload.transaction }),
        );
      } catch {
        txKey = undefined;
      }
    }
    if (txKey && this.settlementCache.isDuplicate(txKey)) {
      return {
        success: false,
        errorReason: Errors.ErrDuplicateSettlement,
        transaction: "",
        network: requirements.network,
      };
    }

    const verification = await this.verify(payload, requirements);
    if (!verification.isValid) {
      if (txKey) {
        this.settlementCache.delete(txKey);
      }
      return {
        success: false,
        errorReason: verification.invalidReason ?? Errors.ErrVerificationFailed,
        transaction: "",
        network: requirements.network,
        payer: verification.payer,
      };
    }

    const parsed = parseAtomicBatchItems(requirements);
    const amount = parsed.ok ? parsed.total.toString() : undefined;

    let signature: string | undefined;
    try {
      signature = await this.signer.sendTransaction(
        (batchPayload as AtomicBatchSvmPayloadV2).transaction,
        requirements.network,
      );
      await this.signer.confirmTransaction(signature, requirements.network);
    } catch {
      return {
        success: false,
        errorReason: Errors.ErrTransactionFailed,
        transaction: signature ?? "",
        network: requirements.network,
        payer: verification.payer,
      };
    }

    return {
      success: true,
      transaction: signature as string,
      network: requirements.network,
      payer: verification.payer,
      amount,
    };
  }

  /**
   * Reads an SPL token account's mint and owner from its on-chain data
   * (byte layout: mint at 0..32, owner at 32..64).
   *
   * @param rpc - RPC client for the network
   * @param address - Token account address
   * @returns The mint and owner, or null when unreadable or malformed
   */
  private async readTokenAccount(
    rpc: ReturnType<typeof createRpcClient>,
    address: string,
  ): Promise<{ mint: string; owner: string } | null> {
    try {
      const { value } = await rpc
        .getAccountInfo(address as Address, { encoding: "base64", commitment: "confirmed" })
        .send();
      if (!value) {
        return null;
      }
      const data = value.data as unknown as [string, string];
      const bytes = base64Encoder.encode(data[0]);
      if (bytes.length < TOKEN_ACCOUNT_LENGTH) {
        return null;
      }
      return {
        mint: base58Decoder.decode(bytes.slice(0, 32)),
        owner: base58Decoder.decode(bytes.slice(32, 64)),
      };
    } catch {
      return null;
    }
  }
}

/**
 * Verifies one Ed25519 signature over the transaction message bytes
 * (same local-verification approach as the exact SVM facilitator, so
 * verify never depends on RPC `sigVerify`).
 *
 * @param address - Base58 signer address (raw 32-byte public key)
 * @param signature - 64-byte Ed25519 signature
 * @param messageBytes - Transaction message bytes the signature covers
 * @returns Whether the signature is valid
 */
async function verifyEd25519(
  address: string,
  signature: Parameters<typeof verifySignature>[1],
  messageBytes: Parameters<typeof verifySignature>[2],
): Promise<boolean> {
  try {
    const publicKeyBytes = addressEncoder.encode(address as Address);
    const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, "Ed25519", false, [
      "verify",
    ]);
    return await verifySignature(publicKey, signature, messageBytes);
  } catch {
    return false;
  }
}
