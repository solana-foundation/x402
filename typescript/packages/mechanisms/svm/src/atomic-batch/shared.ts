import type { PaymentRequirements } from "@x402/core/types";
import type { AtomicBatchItem } from "../types";
import { validateSvmAddress } from "../utils";

/**
 * Maximum number of payments in one atomic batch.
 *
 * Bounded by Solana's transaction size limit: each `TransferChecked`
 * instruction plus its accounts must fit alongside the payer, the mint,
 * and the token program in a single legacy/v0 transaction.
 */
export const ATOMIC_BATCH_MAX_ITEMS = 8;

/**
 * Result of parsing the batch items out of payment requirements.
 */
export type AtomicBatchItemsResult =
  | { ok: true; items: AtomicBatchItem[]; total: bigint }
  | { ok: false; reason: "missing" | "invalid" | "sum_mismatch" };

/**
 * Parses and validates the `extra.items` batch enumeration of an
 * `atomic-batch` payment requirements object.
 *
 * A valid batch has 1..{@link ATOMIC_BATCH_MAX_ITEMS} items, each with a
 * valid recipient address and a positive base-unit amount, no repeated
 * recipient, and a top-level `amount` equal to the sum of the items.
 *
 * @param requirements - The payment requirements to parse
 * @returns The validated items and their total, or the failure class
 */
export function parseAtomicBatchItems(
  requirements: PaymentRequirements,
): AtomicBatchItemsResult {
  const raw = requirements.extra?.items;
  if (raw === undefined) {
    return { ok: false, reason: "missing" };
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ATOMIC_BATCH_MAX_ITEMS) {
    return { ok: false, reason: "invalid" };
  }

  const items: AtomicBatchItem[] = [];
  const seenPayTo = new Set<string>();
  let total = 0n;
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      return { ok: false, reason: "invalid" };
    }
    const { payTo, amount } = entry as { payTo?: unknown; amount?: unknown };
    if (typeof payTo !== "string" || !validateSvmAddress(payTo)) {
      return { ok: false, reason: "invalid" };
    }
    if (typeof amount !== "string" || !/^\d+$/.test(amount) || BigInt(amount) <= 0n) {
      return { ok: false, reason: "invalid" };
    }
    if (seenPayTo.has(payTo)) {
      return { ok: false, reason: "invalid" };
    }
    seenPayTo.add(payTo);
    total += BigInt(amount);
    items.push({ payTo, amount });
  }

  let declared: bigint;
  try {
    declared = BigInt(requirements.amount);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (declared !== total) {
    return { ok: false, reason: "sum_mismatch" };
  }

  return { ok: true, items, total };
}
