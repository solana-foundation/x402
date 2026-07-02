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
  createNoopSigner,
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

import {
  getOpenInstruction,
  getOpenInstructionDataDecoder,
  OPEN_DISCRIMINATOR,
} from "./generated/instructions/open";
import { findEventAuthorityPda } from "./generated/pdas/eventAuthority";
import { COMPUTE_BUDGET_PROGRAM_ADDRESS } from "../constants";
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
  /** Channel payee. For delegated `upto`, this is the operator/facilitator. */
  payee: string;
  /** SPL mint. */
  mint: string;
  /** Operator key — the transaction fee payer (and the default voucher signer). */
  operator: string;
  /**
   * Channel voucher signer (base58). Defaults to {@link operator} (the `upto`
   * pull model). The `batch-settlement` client-voucher model passes the payer
   * here so the client signs its own cumulative vouchers.
   */
  authorizedSigner?: string | undefined;
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
  const authorizedSigner = address(args.authorizedSigner ?? args.operator);
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
    authorizedSigner: args.authorizedSigner ?? args.operator,
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

  // rentPayer is the operator / fee payer: it funds the channel PDA + escrow-ATA
  // rent at open. It is the same key set as fee payer below, so the single
  // operator signature added by the facilitator covers both the fee-payer and
  // rentPayer signer roles. When the operator is the payer itself, reuse the
  // payer signer instance (kit rejects two distinct signer objects for one
  // address); otherwise a noop signer carries the operator address into the
  // instruction without signing here.
  const rentPayerSigner = operator === payer.address ? payer : createNoopSigner(operator);

  const instruction = getOpenInstruction(
    {
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      authorizedSigner,
      channel: address(channelId),
      channelTokenAccount,
      eventAuthority,
      mint,
      openArgs: { deposit: args.deposit, gracePeriod, recipients, salt },
      payee,
      payer,
      rentPayer: rentPayerSigner,
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
  /**
   * Operator key expected in the `rentPayer` slot (base58). The operator
   * co-signs the open as both fee payer and rentPayer; binding this guards
   * against a client smuggling a different rent-funding account.
   */
  operator: string;
  /** SPL mint expected in the open. */
  mint: string;
  /** Authorized ceiling — the open deposit must equal it exactly (`topUp` can
   *  raise an open channel's deposit, so `>=` would leave the ceiling advisory). */
  maxCap: bigint;
  /** Primary recipient (payTo). */
  payee: string;
  /** Optional payment-channels program id override. */
  programId?: string | undefined;
  /** Expected distribution splits sealed into the channel. */
  recipients?: readonly ChannelSplit[] | undefined;
}

/** Channel facts extracted from a verified open transaction. */
export interface VerifyOpenResult {
  channelId: string;
  payer: string;
  deposit: bigint;
  gracePeriod: number;
  recipients: readonly ChannelSplit[];
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
    addressTableLookups?: readonly unknown[];
    instructions: readonly {
      accountIndices?: readonly number[];
      data?: Uint8Array | undefined;
      programAddressIndex: number;
    }[];
    staticAccounts: readonly string[];
  };

  // The operator co-signs (and fee-pays) this client-supplied transaction, so a
  // malicious client could otherwise smuggle an operator-authorized instruction
  // (e.g. `SystemProgram.transfer { from: operator }`) alongside the open and
  // drain the operator. Two defenses, before any account binding:
  //   1. Reject Address Lookup Tables — they hide instruction programs/accounts
  //      from `staticAccounts`. The in-SDK open builder never uses them.
  //   2. Allowlist instruction programs to exactly { payment-channels `open`,
  //      ComputeBudget }, with exactly one `open`. Nothing else gets the
  //      operator's signature.
  if (message.addressTableLookups && message.addressTableLookups.length > 0) {
    throw new Error(
      "verifyOpenTransaction: address-lookup tables are not permitted in an open transaction — all accounts must be static so the fee-payer guard can validate them",
    );
  }
  let openIx: { accountIndices: readonly number[]; data: Uint8Array } | undefined;
  let openCount = 0;
  for (const ix of message.instructions) {
    const program = message.staticAccounts[ix.programAddressIndex];
    if (program === programIdStr) {
      if (!ix.data || ix.data.length < 1 || ix.data[0] !== OPEN_DISCRIMINATOR) {
        throw new Error(
          "verifyOpenTransaction: payment-channels instruction is not `open` (only the channel open may be co-signed)",
        );
      }
      openCount += 1;
      openIx = { accountIndices: ix.accountIndices ?? [], data: ix.data };
      continue;
    }
    if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) continue;
    throw new Error(
      `verifyOpenTransaction: disallowed instruction program ${program} — the operator co-signs, so only the channel open (+ ComputeBudget) is permitted`,
    );
  }
  if (openCount !== 1) {
    throw new Error(
      `verifyOpenTransaction: expected exactly one open instruction, found ${openCount}`,
    );
  }
  if (!openIx) throw new Error("verifyOpenTransaction: no payment-channels open instruction found");

  const indices = openIx.accountIndices;
  if (indices.length < 8) {
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
  // Open account layout: 0 payer, 1 rentPayer, 2 payee, 3 mint,
  // 4 authorizedSigner, 5 channel, ...
  const payerAddr = accountAt(0, "payer");
  const rentPayerAddr = accountAt(1, "rentPayer");
  const payeeAddr = accountAt(2, "payee");
  const mintAddr = accountAt(3, "mint");
  const authorizedSignerAddr = accountAt(4, "authorizedSigner");
  const channelAddr = accountAt(5, "channel");

  if (rentPayerAddr !== expected.operator) {
    throw new Error(
      `verifyOpenTransaction: rentPayer ${rentPayerAddr} != expected operator ${expected.operator}`,
    );
  }
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

  const openData = getOpenInstructionDataDecoder().decode(openIx.data);
  const { deposit, gracePeriod, recipients, salt } = openData.openArgs;

  if (deposit === 0n) throw new Error("verifyOpenTransaction: deposit must be greater than zero");
  if (deposit !== expected.maxCap) {
    throw new Error(
      `verifyOpenTransaction: deposit ${deposit} != maxCap ${expected.maxCap} — the deposit is the enforced ceiling and \`topUp\` can raise an open channel's deposit, so it must equal the authorized amount exactly`,
    );
  }
  const expectedRecipients = expected.recipients ?? [];
  if (recipients.length !== expectedRecipients.length) {
    throw new Error(
      `verifyOpenTransaction: expected ${expectedRecipients.length} distribution recipients, found ${recipients.length}`,
    );
  }
  for (let i = 0; i < expectedRecipients.length; i += 1) {
    const expectedRecipient = expectedRecipients[i];
    const actualRecipient = recipients[i];
    if (!expectedRecipient || !actualRecipient) {
      throw new Error(`verifyOpenTransaction: missing distribution recipient at index ${i}`);
    }
    if (actualRecipient.recipient !== expectedRecipient.recipient) {
      throw new Error(
        `verifyOpenTransaction: distribution recipient ${actualRecipient.recipient} != expected ${expectedRecipient.recipient} at index ${i}`,
      );
    }
    if (actualRecipient.bps !== expectedRecipient.bps) {
      throw new Error(
        `verifyOpenTransaction: distribution bps ${actualRecipient.bps} != expected ${expectedRecipient.bps} at index ${i}`,
      );
    }
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

  return {
    channelId: channelAddr,
    deposit,
    gracePeriod,
    payer: payerAddr,
    recipients: recipients.map(recipient => ({
      bps: recipient.bps,
      recipient: recipient.recipient,
    })),
    salt,
  };
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
