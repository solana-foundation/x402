import type {
  AssetAmount,
  MoneyParser,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
} from "@x402/core/types";
import type { SvmStablecoinSymbol } from "../../constants";
import { convertToTokenAmount, getStablecoinAddress, numberToDecimalString } from "../../utils";

type ParsedMoney = {
  amount: number;
  stablecoin?: SvmStablecoinSymbol;
};

const PRICE_STABLECOINS = new Set(["USDC", "USDT", "USDG", "PYUSD", "CASH"]);

/**
 * SVM server implementation for the `upto` payment scheme.
 *
 * Price parsing matches the exact scheme (stablecoin → 6-decimal atomic units);
 * `enhancePaymentRequirements` folds the facilitator's `getExtra` (the operator
 * `facilitatorAddress`, optional `facilitatorFee`, and `channelProgram`) into the
 * requirement so the client can build the channel open. The `amount` is phase-dependent:
 * the authorized maximum at verification, the actual charge at settlement.
 */
export class UptoSvmScheme implements SchemeNetworkServer {
  readonly scheme = "upto";
  private moneyParsers: MoneyParser[] = [];

  /**
   * Register a custom money parser in the parser chain (tried in order).
   *
   * @param parser - Custom function to convert an amount to an AssetAmount (or null to skip)
   * @returns This instance for chaining
   */
  registerMoneyParser(parser: MoneyParser): UptoSvmScheme {
    this.moneyParsers.push(parser);
    return this;
  }

  /**
   * Parse a price into an asset amount. AssetAmount inputs pass through; Money
   * inputs are parsed to a decimal and run through the parser chain, falling
   * back to the default stablecoin conversion.
   *
   * @param price - The price to parse
   * @param network - The network to use
   * @returns The parsed asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price === "object" && price !== null && "amount" in price) {
      if (!price.asset) {
        throw new Error(`Asset address must be specified for AssetAmount on network ${network}`);
      }
      return {
        amount: price.amount,
        asset: price.asset,
        extra: price.extra || {},
      };
    }

    const { amount, stablecoin } = this.parseMoney(price);

    for (const parser of this.moneyParsers) {
      const result = await parser(amount, network);
      if (result !== null) {
        return result;
      }
    }

    return this.defaultMoneyConversion(amount, network, stablecoin);
  }

  /**
   * Fold the facilitator's `getExtra` payload (operator address, fee payer,
   * optional fee/program id) into the requirement so the client can build the
   * channel open against this facilitator.
   *
   * @param paymentRequirements - The base payment requirements
   * @param supportedKind - The supported kind from the facilitator's /supported endpoint
   * @param supportedKind.x402Version - The x402 version
   * @param supportedKind.scheme - The payment scheme
   * @param supportedKind.network - The network identifier
   * @param supportedKind.extra - Facilitator extra (facilitatorAddress / facilitatorFee / channelProgram)
   * @param extensionKeys - Extension keys supported by the facilitator (unused)
   * @returns Enhanced payment requirements
   */
  enhancePaymentRequirements(
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
    return Promise.resolve({
      ...paymentRequirements,
      extra: {
        ...paymentRequirements.extra,
        ...supportedKind.extra,
      },
    });
  }

  /**
   * Parse Money (string | number) to a decimal number, recognizing a trailing
   * stablecoin symbol (e.g. "$1.50", "1.50 PYUSD").
   *
   * @param money - The money value to parse
   * @returns The decimal amount and optional stablecoin symbol
   */
  private parseMoney(money: string | number): ParsedMoney {
    if (typeof money === "number") {
      return { amount: money };
    }

    const cleanMoney = money.replace(/^\$/, "").trim();
    const amount = parseFloat(cleanMoney);

    if (isNaN(amount)) {
      throw new Error(`Invalid money format: ${money}`);
    }

    const suffix = cleanMoney
      .match(/[A-Za-z][A-Za-z0-9]*\s*$/)?.[0]
      .trim()
      .toUpperCase();
    if (suffix === "USD") {
      return { amount, stablecoin: "USDC" };
    }
    if (suffix && PRICE_STABLECOINS.has(suffix)) {
      return { amount, stablecoin: suffix as SvmStablecoinSymbol };
    }

    return { amount };
  }

  /**
   * Default money conversion: decimal amount → 6-decimal stablecoin atomic units.
   *
   * @param amount - The decimal amount
   * @param network - The network to use
   * @param stablecoin - Stablecoin symbol; defaults to USDC
   * @returns The parsed asset amount
   */
  private defaultMoneyConversion(
    amount: number,
    network: Network,
    stablecoin: SvmStablecoinSymbol = "USDC",
  ): AssetAmount {
    const tokenAmount = convertToTokenAmount(numberToDecimalString(amount), 6);
    return {
      amount: tokenAmount,
      asset: getStablecoinAddress(stablecoin, network),
      extra: {},
    };
  }
}
