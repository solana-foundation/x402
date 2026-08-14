/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/instructions/settle.ts
 *
 * Parsing helpers omitted; only the synchronous `getSettleInstruction` builder
 * is needed. `settle` advances the on-chain settlement watermark to the
 * voucher's cumulative amount without finalizing the channel (the batched
 * redemption path). The voucher is read from the Ed25519 precompile referenced
 * via the instructions sysvar, so the instruction carries no voucher args and is
 * permissionless — the signature in the preceding precompile is the authority.
 */

import {
  type AccountMeta,
  type Address,
  type FixedSizeEncoder,
  type Instruction,
  type InstructionWithAccounts,
  type InstructionWithData,
  type ReadonlyAccount,
  type ReadonlyUint8Array,
  transformEncoder,
  type WritableAccount,
} from "@solana/kit";

import { getAccountMetaFactory, type ResolvedInstructionAccount } from "../account-meta";
import { PAYMENT_CHANNELS_PROGRAM_ADDRESS } from "../programs/paymentChannels";
import { getU8Encoder } from "../safe-codecs";

export const SETTLE_DISCRIMINATOR = 2;

/**
 *
 */
export function getSettleDiscriminatorBytes(): ReadonlyUint8Array {
  return getU8Encoder().encode(SETTLE_DISCRIMINATOR);
}

export type SettleInstruction<
  TProgram extends string = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
  TAccountChannel extends AccountMeta<string> | string = string,
  TAccountInstructionsSysvar extends AccountMeta<string> | string = string,
  TRemainingAccounts extends readonly AccountMeta<string>[] = [],
> = Instruction<TProgram> &
  InstructionWithAccounts<
    [
      TAccountChannel extends string ? WritableAccount<TAccountChannel> : TAccountChannel,
      TAccountInstructionsSysvar extends string
        ? ReadonlyAccount<TAccountInstructionsSysvar>
        : TAccountInstructionsSysvar,
      ...TRemainingAccounts,
    ]
  > &
  InstructionWithData<ReadonlyUint8Array>;

/** `settle` carries no arguments beyond the injected discriminator byte. */
export type SettleInstructionDataArgs = Record<string, never>;

/**
 * Encoder for the `settle` instruction data — a single discriminator byte.
 *
 * @returns The fixed-size encoder
 */
export function getSettleInstructionDataEncoder(): FixedSizeEncoder<SettleInstructionDataArgs> {
  return transformEncoder(getU8Encoder(), () => SETTLE_DISCRIMINATOR);
}

export type SettleInput<
  TAccountChannel extends string = string,
  TAccountInstructionsSysvar extends string = string,
> = {
  channel: Address<TAccountChannel>;
  instructionsSysvar: Address<TAccountInstructionsSysvar>;
};

/**
 *
 * @param input
 * @param config
 * @param config.programAddress
 */
export function getSettleInstruction<
  TAccountChannel extends string,
  TAccountInstructionsSysvar extends string,
  TProgramAddress extends Address = typeof PAYMENT_CHANNELS_PROGRAM_ADDRESS,
>(
  input: SettleInput<TAccountChannel, TAccountInstructionsSysvar>,
  config?: { programAddress?: TProgramAddress },
): SettleInstruction<TProgramAddress, TAccountChannel, TAccountInstructionsSysvar> {
  const programAddress = config?.programAddress ?? PAYMENT_CHANNELS_PROGRAM_ADDRESS;

  const originalAccounts = {
    channel: { isWritable: true, value: input.channel ?? null },
    instructionsSysvar: { isWritable: false, value: input.instructionsSysvar ?? null },
  };
  const accounts = originalAccounts as Record<
    keyof typeof originalAccounts,
    ResolvedInstructionAccount
  >;

  const getAccountMeta = getAccountMetaFactory(programAddress, "programId");
  return Object.freeze({
    accounts: [
      getAccountMeta("channel", accounts.channel),
      getAccountMeta("instructionsSysvar", accounts.instructionsSysvar),
    ],
    data: getSettleInstructionDataEncoder().encode({}),
    programAddress,
  } as SettleInstruction<TProgramAddress, TAccountChannel, TAccountInstructionsSysvar>);
}
