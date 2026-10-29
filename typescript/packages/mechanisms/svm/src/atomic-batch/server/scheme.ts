import type {
  AssetAmount,
  Network,
  PaymentFlowConfig,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  MoneyParser,
} from "@x402/core/types";
import { parseMoney } from "@x402/core/utils";
import { findDefaultAsset } from "../../defaultAssets";
import { parseAtomicBatchItems } from "../shared";

/**
 * SVM server implementation for the Atomic Batch payment scheme.
 *
 * An atomic-batch price is inherently itemized: the resource server
 * expresses it as an `AssetAmount` whose `extra.items` enumerates every
 * recipient and amount in the batch. `parsePrice` validates the items and
 * derives the top-level amount as their sum; `enhancePaymentRequirements`
 * re-validates and pins `payTo` to the first item for core-schema
 * compatibility (verifiers treat `extra.items` as authoritative).
 */
export class AtomicBatchSvmScheme implements SchemeNetworkServer {
  readonly scheme = "atomic-batch";
  readonly defaultAssetTransferMethod = "default";
  readonly paymentFlows = {
    default: { supported: ["upfront"], default: "upfront" },
  } as const satisfies Record<string, PaymentFlowConfig>;
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain.
   * A parser for this scheme receives a decimal string and must return an
   * `AssetAmount` carrying the batch in `extra.items` (or null to skip).
   *
   * @param parser - Custom function to convert amount to AssetAmount (or null to skip)
   * @returns The service instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): AtomicBatchSvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Decimals for a known default asset, or undefined.
   *
   * @param asset - Asset address or symbol
   * @param network - Target network
   * @returns Decimals when the asset is a known default; otherwise undefined
   */
  getAssetDecimals(asset: string, network: Network): number | undefined {
    return findDefaultAsset(asset, network)?.decimals;
  }

  /**
   * Parses a price into an asset amount.
   * The price must be an AssetAmount (or a custom parser's output) whose
   * `extra.items` enumerate the batch; the returned amount is the item sum.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns Promise that resolves to the parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return this.itemizedAmount(price.asset, price.extra || {}, network);
    }

    // Money input: only a registered parser can turn a bare amount into a
    // batch, because the recipients cannot be inferred from an amount.
    const { amount } = parseMoney(price);
    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        if (!result.asset) {
          throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
        }
        return this.itemizedAmount(result.asset, result.extra || {}, network);
      }
    }

    throw new Error(
      "atomic-batch requires an itemized price: pass an AssetAmount whose extra.items lists each recipient ({ payTo, amount })",
    );
  }

  /**
   * Build payment requirements for this scheme/network combination.
   * Validates the batch items and derives the top-level `amount` (item
   * sum) and `payTo` (first item's recipient).
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind configuration
   * @param supportedKind.x402Version - The x402 protocol version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Extra metadata from the facilitator
   * @param extensionKeys - Extension keys supported by the facilitator
   * @returns Enhanced payment requirements with validated batch items
   */
  async enhancePaymentRequirements(
    paymentRequirements: PaymentRequirements,
    supportedKind: {
      x402Version: number;
      scheme: string;
      network: Network;
      extra?: Record<string, unknown>;
    },
    extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    void extensionKeys;
    void supportedKind;

    // Validate the items independent of the declared top-level amount
    // (which this method derives): parse against the computed item sum.
    // A server that misconfigures its batch fails loudly here instead of
    // advertising requirements no client can satisfy.
    const parsed = parseAtomicBatchItems({
      ...paymentRequirements,
      amount: sumOfItems(paymentRequirements.extra?.items),
    });
    if (!parsed.ok) {
      throw new Error(
        `atomic-batch requirements are ${parsed.reason}: extra.items must enumerate 1-8 payments with unique recipients and positive amounts`,
      );
    }

    return {
      ...paymentRequirements,
      amount: parsed.total.toString(),
      payTo: parsed.items[0].payTo,
      extra: {
        ...paymentRequirements.extra,
        items: parsed.items,
      },
    };
  }

  /**
   * Validates an itemized price and returns it with the amount set to the
   * item sum.
   *
   * @param asset - The asset (mint) address
   * @param extra - Extra fields, expected to carry `items`
   * @param network - The network (used for requirement reconstruction)
   * @returns The normalized asset amount
   */
  private itemizedAmount(
    asset: string,
    extra: Record<string, unknown>,
    network: Network,
  ): AssetAmount {
    const parsed = parseAtomicBatchItems({
      scheme: this.scheme,
      network,
      asset,
      amount: sumOfItems(extra.items),
      payTo: "",
      maxTimeoutSeconds: 0,
      extra,
    });
    if (!parsed.ok) {
      throw new Error(
        `atomic-batch price is ${parsed.reason}: extra.items must enumerate 1-8 payments with unique recipients and positive amounts`,
      );
    }
    return {
      amount: parsed.total.toString(),
      asset,
      extra: { ...extra, items: parsed.items },
    };
  }
}

/**
 * Sums an unvalidated `extra.items` value for validation purposes.
 * Returns "0" when the value is not a summable item list; the strict
 * parser reports the real error.
 *
 * @param items - The raw items value
 * @returns The decimal-string sum, or "0"
 */
function sumOfItems(items: unknown): string {
  if (!Array.isArray(items)) return "0";
  let total = 0n;
  for (const entry of items) {
    const amount = (entry as { amount?: unknown })?.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) return "0";
    total += BigInt(amount);
  }
  return total.toString();
}
