/**
 * Minimal payment-channels `request_close` instruction builder.
 * Vendored from the Codama-generated payment-channel client.
 */

import {
  type AccountMeta,
  type AccountSignerMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type TransactionSigner,
  type WritableAccount,
  type ReadonlySignerAccount,
} from "@solana/kit";

import { getAccountMetaFactory, type ResolvedInstructionAccount } from "../account-meta";
import { PAYMENT_CHANNELS_PROGRAM_ADDRESS } from "../programs/paymentChannels";
import { getU8Encoder } from "../safe-codecs";

export const REQUEST_CLOSE_DISCRIMINATOR = 5;

export type RequestCloseInstruction<
  TProgram extends string = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
  TAccountPayer extends AccountMeta<string> | string = string,
  TAccountChannel extends AccountMeta<string> | string = string,
> = Instruction<TProgram> &
  InstructionWithAccounts<
    [
      TAccountPayer extends string
        ? AccountSignerMeta<TAccountPayer> & ReadonlySignerAccount<TAccountPayer>
        : TAccountPayer,
      TAccountChannel extends string ? WritableAccount<TAccountChannel> : TAccountChannel,
    ]
  > &
  InstructionWithData<ReadonlyUint8Array>;

export function getRequestCloseInstruction<
  TAccountPayer extends string,
  TAccountChannel extends string,
  TProgramAddress extends Address = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
>(
  input: {
    payer: TransactionSigner<TAccountPayer>;
    channel: Address<TAccountChannel>;
  },
  config?: { programAddress?: TProgramAddress },
): RequestCloseInstruction<TProgramAddress, TAccountPayer, TAccountChannel> {
  const programAddress = config?.programAddress ?? PAYMENT_CHANNELS_PROGRAM_ADDRESS;
  const accounts = {
    payer: { isWritable: false, value: input.payer },
    channel: { isWritable: true, value: input.channel },
  } as Record<"payer" | "channel", ResolvedInstructionAccount>;
  const getAccountMeta = getAccountMetaFactory(programAddress, "programId");
  return Object.freeze({
    accounts: [
      getAccountMeta("payer", accounts.payer),
      getAccountMeta("channel", accounts.channel),
    ],
    data: getU8Encoder().encode(REQUEST_CLOSE_DISCRIMINATOR),
    programAddress,
  }) as RequestCloseInstruction<TProgramAddress, TAccountPayer, TAccountChannel>;
}
