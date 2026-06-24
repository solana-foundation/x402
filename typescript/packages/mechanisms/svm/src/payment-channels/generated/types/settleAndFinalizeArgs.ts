/**
 * Vendored from
 * https://github.com/solana-foundation/payment-channel/blob/main/clients/typescript/src/generated/types/settleAndFinalizeArgs.ts
 */

import {
  combineCodec,
  type FixedSizeCodec,
  type FixedSizeDecoder,
  type FixedSizeEncoder,
  getStructDecoder,
  getStructEncoder,
} from "@solana/kit";

import { getU8Decoder, getU8Encoder } from "../safe-codecs";

export type SettleAndFinalizeArgs = {
  hasVoucher: number;
};

export type SettleAndFinalizeArgsArgs = {
  hasVoucher: number;
};

/**
 *
 */
export function getSettleAndFinalizeArgsEncoder(): FixedSizeEncoder<SettleAndFinalizeArgsArgs> {
  return getStructEncoder([["hasVoucher", getU8Encoder()]]);
}

/**
 *
 */
export function getSettleAndFinalizeArgsDecoder(): FixedSizeDecoder<SettleAndFinalizeArgs> {
  return getStructDecoder([["hasVoucher", getU8Decoder()]]);
}

/**
 *
 */
export function getSettleAndFinalizeArgsCodec(): FixedSizeCodec<
  SettleAndFinalizeArgsArgs,
  SettleAndFinalizeArgs
> {
  return combineCodec(getSettleAndFinalizeArgsEncoder(), getSettleAndFinalizeArgsDecoder());
}
