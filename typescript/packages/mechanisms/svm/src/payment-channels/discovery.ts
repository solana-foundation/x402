/** Onchain payment-channel discovery keyed by the key that fronted account rent. */

import { address, type Address, type Base58EncodedBytes } from "@solana/kit";

import type { ChannelRpc } from "../upto/facilitator/channel";
import type { Channel } from "./generated/accounts/channel";
import { getChannelDecoder } from "./generated/accounts/channel";
import { PAYMENT_CHANNELS_PROGRAM_ID } from "./onchain";
import { findPaymentChannelPda } from "./open";

/** Fixed byte length of the payment-channel account layout. */
export const CHANNEL_ACCOUNT_SIZE = 256n;
/** Byte offset of `Channel.rent_payer`. */
export const CHANNEL_RENT_PAYER_OFFSET = 216n;

/** A decoded channel whose account owner and canonical PDA were revalidated. */
export interface DiscoveredChannel {
  channelId: string;
  channel: Channel;
}

/**
 * Discover and independently validate channels for which a facilitator paid rent.
 *
 * @param rpc - Solana RPC client
 * @param rentPayer - Facilitator rent-payer address
 * @param programId - Optional payment-channel program override
 * @returns Validated channels
 */
export async function discoverChannelsByRentPayer(
  rpc: ChannelRpc,
  rentPayer: string,
  programId?: string,
): Promise<DiscoveredChannel[]> {
  const program = address(programId ?? PAYMENT_CHANNELS_PROGRAM_ID);
  const results = await rpc
    .getProgramAccounts(program, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        { dataSize: CHANNEL_ACCOUNT_SIZE },
        {
          memcmp: {
            bytes: rentPayer as Base58EncodedBytes,
            encoding: "base58",
            offset: CHANNEL_RENT_PAYER_OFFSET,
          },
        },
      ],
    })
    .send();

  const discovered: DiscoveredChannel[] = [];
  for (const result of results) {
    const validated = await validateDiscoveredAccount(
      result.pubkey,
      result.account.owner,
      result.account.data[0],
      program,
    );
    if (validated) discovered.push(validated);
  }
  return discovered;
}

async function validateDiscoveredAccount(
  pubkey: Address,
  owner: Address,
  base64Data: string,
  expectedProgram: Address,
): Promise<DiscoveredChannel | undefined> {
  if (owner !== expectedProgram) return undefined;
  const bytes = Buffer.from(base64Data, "base64");
  if (bytes.byteLength < Number(CHANNEL_ACCOUNT_SIZE)) return undefined;

  let channel: Channel;
  try {
    channel = getChannelDecoder().decode(bytes);
  } catch {
    return undefined;
  }
  if (channel.discriminator !== 1) return undefined;

  const derived = await findPaymentChannelPda({
    authorizedSigner: channel.authorizedSigner,
    mint: channel.mint,
    openSlot: channel.openSlot,
    payee: channel.payee,
    payer: channel.payer,
    salt: channel.salt,
  });
  if (derived !== pubkey) return undefined;
  return { channel, channelId: pubkey };
}
