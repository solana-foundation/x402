/** Minimal payment-channels `seal` instruction builder. */

import {
  type AccountMeta,
  type Address,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyUint8Array,
  type WritableAccount,
} from "@solana/kit";

import { getAccountMetaFactory, type ResolvedInstructionAccount } from "../account-meta";
import { PAYMENT_CHANNELS_PROGRAM_ADDRESS } from "../programs/paymentChannels";
import { getU8Encoder } from "../safe-codecs";

export const SEAL_DISCRIMINATOR = 6;

export type SealInstruction<
  TProgram extends string = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
  TAccountChannel extends AccountMeta<string> | string = string,
> = Instruction<TProgram> &
  InstructionWithAccounts<
    [TAccountChannel extends string ? WritableAccount<TAccountChannel> : TAccountChannel]
  > &
  InstructionWithData<ReadonlyUint8Array>;

export function getSealInstruction<
  TAccountChannel extends string,
  TProgramAddress extends Address = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
>(
  input: { channel: Address<TAccountChannel> },
  config?: { programAddress?: TProgramAddress },
): SealInstruction<TProgramAddress, TAccountChannel> {
  const programAddress = config?.programAddress ?? PAYMENT_CHANNELS_PROGRAM_ADDRESS;
  const accounts = {
    channel: { isWritable: true, value: input.channel },
  } as Record<"channel", ResolvedInstructionAccount>;
  const getAccountMeta = getAccountMetaFactory(programAddress, "programId");
  return Object.freeze({
    accounts: [getAccountMeta("channel", accounts.channel)],
    data: getU8Encoder().encode(SEAL_DISCRIMINATOR),
    programAddress,
  }) as SealInstruction<TProgramAddress, TAccountChannel>;
}
