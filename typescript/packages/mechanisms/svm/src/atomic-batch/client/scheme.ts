import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientSvmConfig, ClientSvmSigner } from "../../signer";
import type { AtomicBatchSvmPayloadV2 } from "../../types";
import { createRpcClient, resolveBlockhash } from "../../utils";
import { getCachedMintMetadata, type MintMetadataCache } from "../../mint-cache";
import { findDefaultAsset } from "../../defaultAssets";
import { parseAtomicBatchItems } from "../shared";

/**
 * SVM client implementation for the Atomic Batch payment scheme.
 *
 * Builds a single transaction carrying one `TransferChecked` instruction
 * per batch item, with the client as fee payer and sole signer, and signs
 * it once. See specs/schemes/atomic-batch/scheme_atomic_batch_svm.md.
 */
export class AtomicBatchSvmScheme implements SchemeNetworkClient {
  readonly scheme = "atomic-batch";
  findDefaultAsset = findDefaultAsset;
  private readonly mintCache: MintMetadataCache = new Map();

  /**
   * Creates a new AtomicBatchSvmScheme instance.
   *
   * @param signer - The SVM signer for client operations
   * @param config - Optional configuration with custom RPC URL
   * @returns AtomicBatchSvmScheme instance
   */
  constructor(
    private readonly signer: ClientSvmSigner,
    private readonly config?: ClientSvmConfig,
  ) {}

  /**
   * Creates a payment payload for the Atomic Batch scheme.
   *
   * The batch items are read from `paymentRequirements.extra.items`; the
   * transaction contains exactly those transfers and nothing else.
   *
   * @param x402Version - The x402 protocol version
   * @param paymentRequirements - The payment requirements, including `extra.items`
   * @returns Promise resolving to a payment payload
   */
  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
    const parsed = parseAtomicBatchItems(paymentRequirements);
    if (!parsed.ok) {
      throw new Error(
        `atomic-batch requirements are ${parsed.reason}: extra.items must enumerate 1-8 payments whose amounts sum to the top-level amount`,
      );
    }

    const rpc = createRpcClient(paymentRequirements.network, this.config?.rpcUrl);

    const mintMetadata = await getCachedMintMetadata(
      rpc,
      paymentRequirements.network,
      paymentRequirements.asset as Address,
      this.mintCache,
    );
    if (mintMetadata.programAddress.toString() !== TOKEN_PROGRAM_ADDRESS.toString()) {
      throw new Error(
        "atomic-batch supports only classic SPL Token mints in this version (Token-2022 is out of scope)",
      );
    }

    const [sourceATA] = await findAssociatedTokenPda({
      mint: paymentRequirements.asset as Address,
      owner: this.signer.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });

    const transferIxs: ReturnType<typeof getTransferCheckedInstruction>[] = [];
    for (const item of parsed.items) {
      const [destinationATA] = await findAssociatedTokenPda({
        mint: paymentRequirements.asset as Address,
        owner: item.payTo as Address,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
      transferIxs.push(
        getTransferCheckedInstruction(
          {
            source: sourceATA,
            mint: paymentRequirements.asset as Address,
            destination: destinationATA,
            authority: this.signer,
            amount: BigInt(item.amount),
            decimals: mintMetadata.decimals,
          },
          { programAddress: TOKEN_PROGRAM_ADDRESS },
        ),
      );
    }

    const latestBlockhash = await resolveBlockhash(rpc, paymentRequirements);

    // The payer is the fee payer and sole signer, and the transaction
    // contains exactly the batch transfers — no compute-budget, memo, or
    // account-creation instructions (see the scheme's strict allowlist).
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      tx => setTransactionMessageFeePayer(this.signer.address, tx),
      tx => appendTransactionMessageInstructions(transferIxs, tx),
      tx => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    );

    const signedTransaction = await partiallySignTransactionMessageWithSigners(tx);
    const base64EncodedWireTransaction = getBase64EncodedWireTransaction(signedTransaction);

    const payload: AtomicBatchSvmPayloadV2 = {
      transaction: base64EncodedWireTransaction,
    };

    return {
      x402Version,
      payload,
    };
  }
}
