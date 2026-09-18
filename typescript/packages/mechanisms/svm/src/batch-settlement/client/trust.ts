/**
 * Client-side trust policy for server-signed batch-settlement channels.
 *
 * In server mode the channel's onchain `authorized_signer` is the resource
 * operator, so the operator can sign a voucher for the full unspent deposit
 * without any further client signature. A client must therefore never enter
 * that mode because a 402 asked for it; it enters only for operators it has
 * decided to trust out of band, and only up to a deposit it chose.
 */

import type { PaymentRequirements } from "@x402/core/types";

import { parseU64 } from "../../payment-channels/open";
import { BATCH_SETTLEMENT_SCHEME } from "../types";

/** One grant of trust for server-signed channels. At least one of `origin` or `operator` is required. */
export interface BatchServerSignedTrust {
  /**
   * Exact origin (`https://host[:port]`) of the resource server, as seen in
   * the URL this client actually requested. Matching by origin requires the
   * scheme's `paymentRequiredHook` to be registered on the `x402HTTPClient`,
   * because only the HTTP layer knows the real request URL; the 402 body is
   * server-controlled and is never used for this decision.
   */
  origin?: string | undefined;
  /**
   * Base58 operator key. Alone, trusts that key wherever it is advertised.
   * Together with `origin`, pins the key the origin is allowed to advertise so
   * a swapped `extra.operator` cannot open a channel under a different signer.
   */
  operator?: string | undefined;
  /**
   * Cap on the total escrow (initial deposit plus top-ups) this client will
   * lock in a channel under this grant, in atomic units. This is the amount a
   * dishonest operator could take. Server `minDeposit` hints above it are
   * clamped, not honored.
   */
  maxDeposit?: bigint | string | undefined;
}

export interface BatchServerSignedChannelsConfig {
  trust: BatchServerSignedTrust[];
}

/** A matched grant, with `maxDeposit` parsed. */
export interface ResolvedServerSignedTrust {
  origin?: string | undefined;
  operator?: string | undefined;
  maxDeposit?: bigint | undefined;
}

/**
 * Whether an accept asks the client to delegate voucher signing to the operator.
 *
 * @param accept - One entry of `PaymentRequired.accepts`
 * @returns True for a batch-settlement accept in server mode
 */
export function isServerSignedAccept(accept: PaymentRequirements): boolean {
  return accept.scheme === BATCH_SETTLEMENT_SCHEME && accept.extra?.voucherSigner === "server";
}

/**
 * Reduce a URL to its origin, rejecting anything that is not http(s).
 *
 * @param value - Absolute URL or origin
 * @param label - Name used in error messages
 * @returns The normalized `scheme://host[:port]` origin
 */
function normalizeOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${label} must use http or https`);
  }
  return parsed.origin;
}

/**
 * Decides which server-signed accepts a client may act on.
 *
 * Origin grants are recorded per accept object when the HTTP hook sees the
 * request URL; operator-only grants match any accept advertising that key.
 */
export class ServerSignedTrustPolicy {
  private readonly entries: ResolvedServerSignedTrust[];
  private readonly grants = new WeakMap<PaymentRequirements, ResolvedServerSignedTrust>();

  /**
   * Validate and normalize the configured grants.
   *
   * @param entries - Grants from `serverSignedChannels.trust`
   */
  constructor(entries: readonly BatchServerSignedTrust[]) {
    this.entries = entries.map((entry, index) => {
      const label = `serverSignedChannels.trust[${index}]`;
      if (entry.origin === undefined && entry.operator === undefined) {
        throw new Error(`${label} must name an origin, an operator, or both`);
      }
      if (entry.operator !== undefined && entry.operator.length === 0) {
        throw new Error(`${label}.operator must be a non-empty base58 key`);
      }
      const maxDeposit =
        entry.maxDeposit === undefined
          ? undefined
          : parseU64(entry.maxDeposit, `${label}.maxDeposit`);
      if (maxDeposit === 0n) throw new Error(`${label}.maxDeposit must be positive`);
      return {
        ...(entry.origin !== undefined
          ? { origin: normalizeOrigin(entry.origin, `${label}.origin`) }
          : {}),
        ...(entry.operator !== undefined ? { operator: entry.operator } : {}),
        ...(maxDeposit !== undefined ? { maxDeposit } : {}),
      };
    });
  }

  /**
   * Apply the policy to a 402 before payment selection.
   *
   * Server-signed accepts from origins this client does not trust are removed,
   * so the core falls back to whatever else the server offered (typically the
   * same route in client mode). Trusted server-signed accepts are moved ahead
   * of other batch-settlement accepts on the same network so the default
   * selector picks metered pricing where the client has chosen to allow it.
   *
   * Mutates `paymentRequired.accepts` in place: the fetch wrapper hands the
   * same object to payment creation.
   *
   * @param paymentRequired - Decoded 402 body
   * @param paymentRequired.accepts - Offered payment requirements
   * @param requestUrl - URL the client actually requested
   */
  authorize(paymentRequired: { accepts: PaymentRequirements[] }, requestUrl: string): void {
    const origin = normalizeOrigin(requestUrl, "request URL");
    const dropped = new Set<PaymentRequirements>();
    const refusedOperators = new Set<string>();
    for (const accept of paymentRequired.accepts) {
      if (!isServerSignedAccept(accept)) continue;
      const operator = accept.extra?.operator;
      const grant = this.match(origin, typeof operator === "string" ? operator : undefined);
      if (grant) {
        this.grants.set(accept, grant);
      } else {
        dropped.add(accept);
        refusedOperators.add(typeof operator === "string" ? operator : "<missing>");
      }
    }
    if (dropped.size === 0 && paymentRequired.accepts.every(a => !this.grants.has(a))) return;

    const remaining = paymentRequired.accepts.filter(accept => !dropped.has(accept));
    if (remaining.length === 0) {
      throw new Error(untrustedOperatorMessage(origin, [...refusedOperators]));
    }
    const reordered: PaymentRequirements[] = [];
    const networksSeen = new Set<string>();
    for (const accept of remaining) {
      if (accept.scheme === BATCH_SETTLEMENT_SCHEME && !networksSeen.has(accept.network)) {
        networksSeen.add(accept.network);
        for (const candidate of remaining) {
          if (
            candidate.scheme === BATCH_SETTLEMENT_SCHEME &&
            candidate.network === accept.network &&
            this.grants.has(candidate)
          ) {
            reordered.push(candidate);
          }
        }
      }
      if (accept.scheme === BATCH_SETTLEMENT_SCHEME && this.grants.has(accept)) continue;
      reordered.push(accept);
    }
    paymentRequired.accepts = reordered;
  }

  /**
   * The grant under which this client may pay a server-signed accept, if any.
   *
   * An origin-bound grant exists only when `authorize` saw this exact accept
   * object with a trusted request URL. An operator-only grant applies to any
   * accept advertising that key.
   *
   * @param requirements - Selected accept
   * @returns Matching grant, or undefined when the client must refuse
   */
  grantFor(requirements: PaymentRequirements): ResolvedServerSignedTrust | undefined {
    const recorded = this.grants.get(requirements);
    if (recorded) return recorded;
    const operator = requirements.extra?.operator;
    return this.match(undefined, typeof operator === "string" ? operator : undefined);
  }

  /**
   * First grant whose origin and operator constraints both hold.
   *
   * @param origin - Request origin, or undefined when no hook saw the request
   * @param operator - Advertised operator key
   * @returns The matching grant, if any
   */
  private match(
    origin: string | undefined,
    operator: string | undefined,
  ): ResolvedServerSignedTrust | undefined {
    return this.entries.find(
      entry =>
        (entry.origin === undefined || entry.origin === origin) &&
        (entry.operator === undefined || entry.operator === operator),
    );
  }
}

/**
 * Build the refusal message for an untrusted server-signed accept.
 *
 * @param origin - Request origin, when known
 * @param operators - Operators the server advertised
 * @returns Human-readable, actionable error text
 */
export function untrustedOperatorMessage(
  origin: string | undefined,
  operators: readonly string[],
): string {
  const who = origin ? `${origin} ` : "";
  const keys = operators.length > 0 ? operators.join(", ") : "<unknown>";
  return (
    `batch-settlement: ${who}requires a server-signed channel whose operator (${keys}) ` +
    "can claim up to the full channel deposit without further client signatures. " +
    "Trust it explicitly via serverSignedChannels.trust: { origin } together with " +
    "x402HTTPClient.onPaymentRequired(scheme.paymentRequiredHook), or { operator }. " +
    "Set maxDeposit to bound what the operator could take."
  );
}
