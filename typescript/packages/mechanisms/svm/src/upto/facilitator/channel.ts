/**
 * Channel-flow glue for the `upto` facilitator: voucher signing, co-signing and
 * broadcasting the client `open` (idempotent), and submitting settle+distribute.
 *
 * Kept separate from the scheme orchestration so the on-chain mechanics stay
 * readable. All RPC access is threaded in by the caller.
 */

import {
  address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createSignableMessage,
  createTransactionMessage,
  getBase58Decoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type MessagePartialSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";

import { type ServerInstruction } from "../../payment-channels/onchain";
import { encodeVoucherMessageBytes } from "../../payment-channels/voucher";
import { createRpcClient } from "../../utils";

/** The operator signer: signs vouchers (messages) and settlement transactions. */
export type OperatorSigner = TransactionSigner & MessagePartialSigner;

/** RPC client shape used by the channel helpers. */
export type ChannelRpc = ReturnType<typeof createRpcClient>;

/**
 * Sign a payment-channel voucher and return the base58 signature.
 *
 * @param operator - The operator signer (the channel's authorized signer)
 * @param voucher - The voucher fields
 * @param voucher.channelId - Channel PDA (base58)
 * @param voucher.cumulativeAmount - Cumulative settled amount (base units)
 * @param voucher.expiresAt - Voucher deadline (Unix seconds, i64)
 * @returns The base58-encoded 64-byte Ed25519 signature
 */
export async function signVoucher(
  operator: OperatorSigner,
  voucher: { channelId: string; cumulativeAmount: bigint; expiresAt: bigint },
): Promise<string> {
  const message = encodeVoucherMessageBytes(voucher);
  const [dict] = await operator.signMessages([createSignableMessage(message)]);
  const signature = dict[operator.address];
  if (!signature) throw new Error("operator did not return a voucher signature");
  return getBase58Decoder().decode(signature as Uint8Array);
}

/**
 * Whether the channel account already exists on-chain (open already broadcast).
 *
 * @param rpc - The RPC client
 * @param channelId - Channel PDA (base58)
 * @returns Whether the account exists
 */
export async function channelExists(rpc: ChannelRpc, channelId: string): Promise<boolean> {
  const info = await rpc.getAccountInfo(address(channelId), { encoding: "base64" }).send();
  return info.value !== null;
}

/**
 * Co-sign the operator (fee-payer) slot of a partially-signed open transaction,
 * broadcast it, and wait for confirmation. No-op skip is the caller's job
 * (see {@link channelExists}).
 *
 * @param operator - The operator signer (fee payer)
 * @param rpc - The RPC client
 * @param openTransactionBase64 - The client-signed open transaction
 * @returns The broadcast signature
 */
export async function broadcastOpen(
  operator: OperatorSigner,
  rpc: ChannelRpc,
  openTransactionBase64: string,
): Promise<Signature> {
  const tx = getTransactionDecoder().decode(getBase64Codec().encode(openTransactionBase64));
  const signable = { content: tx.messageBytes, signatures: tx.signatures };
  const [dict] = await operator.signMessages([signable as never]);
  const fullySigned = {
    ...tx,
    signatures: { ...tx.signatures, ...dict },
  };
  const wire = getBase64EncodedWireTransaction(
    fullySigned as Parameters<typeof getBase64EncodedWireTransaction>[0],
  );
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/**
 * Compile the settle+distribute instructions into a transaction signed by the
 * operator (fee payer + merchant signer), broadcast it, and confirm.
 *
 * @param operator - The operator signer
 * @param rpc - The RPC client
 * @param instructions - settle_and_finalize (+ optional Ed25519 precompile) then distribute
 * @returns The broadcast signature
 */
export async function submitSettle(
  operator: OperatorSigner,
  rpc: ChannelRpc,
  instructions: readonly ServerInstruction[],
): Promise<Signature> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayerSigner(operator, m),
    m =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: latestBlockhash.blockhash as Blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        },
        m,
      ),
    m => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = await rpc.sendTransaction(wire, { encoding: "base64" }).send();
  await confirmSignature(rpc, signature);
  return signature;
}

/**
 * Poll `getSignatureStatuses` until the signature reaches at least 'confirmed'.
 *
 * @param rpc - The RPC client
 * @param signature - The transaction signature
 * @param timeoutMs - Total time budget (default 30s)
 * @throws If the transaction failed on-chain or the timeout elapses
 */
export async function confirmSignature(
  rpc: ChannelRpc,
  signature: Signature,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status) {
      if (status.err) {
        throw new Error(`tx ${signature} failed on-chain: ${JSON.stringify(status.err)}`);
      }
      const level = status.confirmationStatus;
      if (level === undefined || level === null || level === "confirmed" || level === "finalized") {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for tx ${signature} confirmation`);
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
}
