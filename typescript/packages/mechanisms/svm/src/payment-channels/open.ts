/**
 * Payment-channel open: client-side transaction builder + server-side verifier.
 *
 * Ported from pay-kit `@solana/mpp` (src/client/PaymentChannels.ts and
 * src/server/session/on-chain.ts), scoped to the `upto` pull flow: the client
 * builds a payer-signed `open` transaction with the operator as fee payer and
 * authorized signer; the facilitator validates and broadcasts it.
 */

import {
  appendTransactionMessageInstructions,
  type Address,
  address,
  type Blockhash,
  createTransactionMessage,
  getAddressEncoder,
  getBase64Codec,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
  getU64Encoder,
  getUtf8Encoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type TransactionSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token-2022";

import { getOpenInstruction, OPEN_DISCRIMINATOR } from "./generated/instructions/open";
import { findEventAuthorityPda } from "./generated/pdas/eventAuthority";
import { ASSOCIATED_TOKEN_PROGRAM_ID, PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";

const U64_MAX = (1n << 64n) - 1n;
const RENT_SYSVAR =
  "SysvarRent111111111111111111111111111111111" as Address<"SysvarRent111111111111111111111111111111111">;

/** Default channel close grace period (seconds). Mirrors the Rust client default. */
export const DEFAULT_GRACE_PERIOD_SECONDS = 900;

/** A recipient split, expressed in basis points. */
export interface ChannelSplit {
  bps: number;
  recipient: string;
}

/** Parameters for {@link buildOpenPaymentChannelTransaction}. */
export interface BuildOpenArgs {
  /** Payer (client) signer. Signs the open; pays the deposit. */
  payer: TransactionSigner;
  /** Channel recipient (payTo). */
  payee: string;
  /** SPL mint. */
  mint: string;
  /** Operator key — both the voucher signer (authorizedSigner) and fee payer. */
  operator: string;
  /** Escrow deposit = the authorized ceiling (base units). */
  deposit: bigint;
  /** Token program for the mint. */
  tokenProgram: string;
  /** Recent blockhash for the transaction lifetime. */
  blockhash: { blockhash: string; lastValidBlockHeight: bigint };
  /** Optional channel-derivation salt; random when omitted. */
  salt?: bigint | undefined;
  /** Optional grace period (seconds). */
  gracePeriod?: number | undefined;
  /** Optional payment-channels program id override. */
  programId?: string | undefined;
  /** Optional distribution splits sealed into the channel at open. */
  recipients?: readonly ChannelSplit[] | undefined;
}

/** Result of {@link buildOpenPaymentChannelTransaction}. */
export interface BuiltOpen {
  /** Channel PDA (base58). */
  channelId: string;
  /** Base64 payer-signed (operator fee-payer slot left empty) open transaction. */
  transaction: string;
  /** Escrow deposit (base units). */
  deposit: bigint;
  /** Channel-derivation salt. */
  salt: bigint;
}

/**
 * Derive the channel PDA for the given open parameters.
 *
 * @param args - PDA seeds
 * @param args.payer
 * @param args.payee
 * @param args.mint
 * @param args.authorizedSigner
 * @param args.salt
 * @param args.programId
 * @returns The channel PDA (base58)
 */
export async function findPaymentChannelPda(args: {
  payer: string;
  payee: string;
  mint: string;
  authorizedSigner: string;
  salt: bigint;
  programId?: string | undefined;
}): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID),
    seeds: [
      getUtf8Encoder().encode("channel"),
      getAddressEncoder().encode(address(args.payer)),
      getAddressEncoder().encode(address(args.payee)),
      getAddressEncoder().encode(address(args.mint)),
      getAddressEncoder().encode(address(args.authorizedSigner)),
      getU64Encoder().encode(args.salt),
    ],
  });
  return pda;
}

/**
 * Build the payer-signed payment-channel open transaction (pull flow).
 *
 * The transaction uses the operator as fee payer and is intentionally left
 * partially signed; the facilitator adds the operator signature before
 * broadcasting it.
 *
 * @param args - Open inputs
 * @returns The channel id + base64 transaction + deposit/salt
 */
export async function buildOpenPaymentChannelTransaction(args: BuildOpenArgs): Promise<BuiltOpen> {
  const programAddress = address(args.programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const tokenProgram = address(args.tokenProgram);
  const payer = args.payer;
  const payee = address(args.payee);
  const mint = address(args.mint);
  const operator = address(args.operator);
  const salt = args.salt ?? randomU64();
  const gracePeriod = args.gracePeriod ?? DEFAULT_GRACE_PERIOD_SECONDS;
  const recipients = (args.recipients ?? []).map(r => ({
    bps: r.bps,
    recipient: address(r.recipient),
  }));

  const channelId = await findPaymentChannelPda({
    payer: payer.address,
    payee: args.payee,
    mint: args.mint,
    authorizedSigner: args.operator,
    salt,
    programId: args.programId,
  });

  const [payerTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: payer.address,
    tokenProgram,
  });
  const [channelTokenAccount] = await findAssociatedTokenPda({
    mint,
    owner: address(channelId),
    tokenProgram,
  });
  const [eventAuthority] = await findEventAuthorityPda({ programAddress });

  const instruction = getOpenInstruction(
    {
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      authorizedSigner: operator,
      channel: address(channelId),
      channelTokenAccount,
      eventAuthority,
      mint,
      openArgs: { deposit: args.deposit, gracePeriod, recipients, salt },
      payee,
      payer,
      payerTokenAccount,
      rent: RENT_SYSVAR,
      selfProgram: programAddress,
      tokenProgram,
    },
    { programAddress },
  );

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    msg => setTransactionMessageFeePayer(operator, msg),
    msg =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: args.blockhash.blockhash as Blockhash,
          lastValidBlockHeight: args.blockhash.lastValidBlockHeight,
        },
        msg,
      ),
    msg => appendTransactionMessageInstructions([instruction], msg),
  );
  const signed = await partiallySignTransactionMessageWithSigners(message);

  return {
    channelId,
    deposit: args.deposit,
    salt,
    transaction: getBase64EncodedWireTransaction(signed),
  };
}

/** Expected values the server validates a client-submitted open transaction against. */
export interface VerifyOpenExpected {
  /** Operator key set as the channel authorized signer (base58). */
  authorizedSigner: string;
  /** SPL mint expected in the open. */
  mint: string;
  /** Authorized ceiling — the open deposit must not exceed it. */
  maxCap: bigint;
  /** Primary recipient (payTo). */
  payee: string;
  /** Optional payment-channels program id override. */
  programId?: string | undefined;
}

/** Channel facts extracted from a verified open transaction. */
export interface VerifyOpenResult {
  channelId: string;
  payer: string;
  deposit: bigint;
  gracePeriod: number;
  salt: bigint;
}

/**
 * Decode and validate a client-submitted open transaction (base64).
 *
 * Asserts the embedded open instruction targets the payment-channels program,
 * that `payee`, `mint`, and `authorizedSigner` match expectations, that
 * `deposit ≤ maxCap`, and that the channel PDA matches the recomputed value.
 *
 * @param transactionBase64 - The client-signed open transaction
 * @param expected - Values pinned by the requirements
 * @returns Extracted channel facts
 */
export async function verifyOpenTransaction(
  transactionBase64: string,
  expected: VerifyOpenExpected,
): Promise<VerifyOpenResult> {
  const programIdStr = expected.programId ?? PAYMENT_CHANNELS_PROGRAM_ID;

  const txBytes = getBase64Codec().encode(transactionBase64);
  const decoded = getTransactionDecoder().decode(txBytes);
  const message = getCompiledTransactionMessageDecoder().decode(
    decoded.messageBytes,
  ) as unknown as {
    instructions: readonly {
      accountIndices?: readonly number[];
      data?: Uint8Array | undefined;
      programAddressIndex: number;
    }[];
    staticAccounts: readonly string[];
  };

  let openIx: { accountIndices: readonly number[]; data: Uint8Array } | undefined;
  for (const ix of message.instructions) {
    if (message.staticAccounts[ix.programAddressIndex] !== programIdStr) continue;
    if (!ix.data || ix.data.length < 1 || ix.data[0] !== OPEN_DISCRIMINATOR) continue;
    openIx = { accountIndices: ix.accountIndices ?? [], data: ix.data };
    break;
  }
  if (!openIx) throw new Error("verifyOpenTransaction: no payment-channels open instruction found");

  const indices = openIx.accountIndices;
  if (indices.length < 7) {
    throw new Error(
      `verifyOpenTransaction: open instruction has too few accounts (${indices.length})`,
    );
  }
  const accountAt = (slot: number, label: string): string => {
    const idx = indices[slot];
    const addr = idx === undefined ? undefined : message.staticAccounts[idx];
    if (!addr) throw new Error(`verifyOpenTransaction: missing account at slot ${slot} (${label})`);
    return addr;
  };
  // Open account layout: 0 payer, 1 payee, 2 mint, 3 authorizedSigner, 4 channel, ...
  const payerAddr = accountAt(0, "payer");
  const payeeAddr = accountAt(1, "payee");
  const mintAddr = accountAt(2, "mint");
  const authorizedSignerAddr = accountAt(3, "authorizedSigner");
  const channelAddr = accountAt(4, "channel");

  if (payeeAddr !== expected.payee) {
    throw new Error(`verifyOpenTransaction: payee ${payeeAddr} != expected ${expected.payee}`);
  }
  if (mintAddr !== expected.mint) {
    throw new Error(`verifyOpenTransaction: mint ${mintAddr} != expected ${expected.mint}`);
  }
  if (authorizedSignerAddr !== expected.authorizedSigner) {
    throw new Error(
      `verifyOpenTransaction: authorizedSigner ${authorizedSignerAddr} != expected ${expected.authorizedSigner}`,
    );
  }

  // ix data: [discriminator u8][salt u64][deposit u64][grace u32][recipients...]
  if (openIx.data.length < 1 + 8 + 8 + 4) {
    throw new Error("verifyOpenTransaction: open instruction data too short");
  }
  const view = new DataView(openIx.data.buffer, openIx.data.byteOffset, openIx.data.byteLength);
  const salt = view.getBigUint64(1, true);
  const deposit = view.getBigUint64(9, true);
  const gracePeriod = view.getUint32(17, true);

  if (deposit === 0n) throw new Error("verifyOpenTransaction: deposit must be greater than zero");
  if (deposit > expected.maxCap) {
    throw new Error(`verifyOpenTransaction: deposit ${deposit} exceeds maxCap ${expected.maxCap}`);
  }

  const derivedChannel = await findPaymentChannelPda({
    payer: payerAddr,
    payee: payeeAddr,
    mint: mintAddr,
    authorizedSigner: authorizedSignerAddr,
    salt,
    programId: expected.programId,
  });
  if (derivedChannel !== channelAddr) {
    throw new Error(
      `verifyOpenTransaction: channel PDA ${channelAddr} != derived ${derivedChannel}`,
    );
  }

  return { channelId: channelAddr, deposit, gracePeriod, payer: payerAddr, salt };
}

/**
 * Parse an unsigned-integer-like value (bigint, safe number, or digit string)
 * into a u64 bigint.
 *
 * @param value - The value to parse
 * @param name - Field name for error messages
 * @returns The parsed bigint
 */
export function parseU64(value: bigint | number | string, name: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a safe integer`);
    parsed = BigInt(value);
  } else if (/^\d+$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new Error(`${name} must be an unsigned integer`);
  }
  if (parsed < 0n || parsed > U64_MAX) throw new Error(`${name} must fit in u64`);
  return parsed;
}

/**
 * Generate a random u64 salt.
 *
 * @returns A random u64 bigint
 */
export function randomU64(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}
