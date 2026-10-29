import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  getTransferInstruction,
} from "@solana-program/token-2022";
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  getBase64Codec,
  partiallySignTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Blockhash,
  type TransactionSigner,
} from "@solana/kit";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { AtomicBatchSvmScheme as ClientScheme } from "../../src/atomic-batch/client/scheme";
import { AtomicBatchSvmScheme as ServerScheme } from "../../src/atomic-batch/server/scheme";
import { AtomicBatchSvmScheme as FacilitatorScheme } from "../../src/atomic-batch/facilitator/scheme";
import * as Errors from "../../src/atomic-batch/facilitator/errors";
import type { AtomicBatchItem } from "../../src/types";
import type { FacilitatorSvmSigner } from "../../src/signer";
import { SOLANA_DEVNET_CAIP2 } from "../../src/constants";
import { findDefaultAsset, USDC_DEVNET_ADDRESS } from "../../src/defaultAssets";

const MINT = USDC_DEVNET_ADDRESS as Address;
const DECIMALS = findDefaultAsset(MINT, SOLANA_DEVNET_CAIP2)!.decimals;
const FAKE_BLOCKHASH = {
  blockhash: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" as Blockhash,
  lastValidBlockHeight: 1000n,
};

const addressEncoder = getAddressEncoder();
const base58Decoder = getBase58Decoder();
const base64Decoder = getBase64Decoder();

// ---------------------------------------------------------------------------
// Fake RPC: serves account bytes for the mint and the token accounts the
// facilitator reads (mint metadata via fetchMint, token account ownership).
// ---------------------------------------------------------------------------

const accountBytes = new Map<string, Uint8Array>();

function mintAccountBytes(decimals: number): Uint8Array {
  const bytes = new Uint8Array(82);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0, true); // mintAuthority: None
  bytes[44] = decimals;
  bytes[45] = 1; // isInitialized
  view.setUint32(46, 0, true); // freezeAuthority: None
  return bytes;
}

function tokenAccountBytes(mint: Address, owner: Address): Uint8Array {
  const bytes = new Uint8Array(165);
  bytes.set(addressEncoder.encode(mint), 0);
  bytes.set(addressEncoder.encode(owner), 32);
  return bytes;
}

const fakeRpc = {
  getAccountInfo: vi.fn((address: string, config?: { encoding?: string }) => ({
    send: async () => {
      const bytes = accountBytes.get(address);
      if (!bytes) return { value: null };
      const data =
        config?.encoding === "base58"
          ? base58Decoder.decode(bytes)
          : [base64Decoder.decode(bytes), "base64"];
      return {
        value: {
          data,
          executable: false,
          lamports: 1_000_000,
          owner: TOKEN_PROGRAM_ADDRESS,
          rentEpoch: 0,
          space: bytes.length,
        },
      };
    },
  })),
  getLatestBlockhash: vi.fn(() => ({
    send: async () => ({ value: FAKE_BLOCKHASH }),
  })),
};

vi.mock("../../src/utils", async importOriginal => {
  const original = await importOriginal<typeof import("../../src/utils")>();
  return {
    ...original,
    createRpcClient: vi.fn(() => fakeRpc),
    resolveBlockhash: vi.fn(async () => FAKE_BLOCKHASH),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ata(owner: Address): Promise<Address> {
  const [address] = await findAssociatedTokenPda({
    mint: MINT,
    owner,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return address;
}

async function buildBatchTransaction(
  payer: TransactionSigner,
  transfers: { payTo: Address; amount: bigint }[],
): Promise<string> {
  const source = await ata(payer.address);
  const ixs: ReturnType<typeof getTransferCheckedInstruction>[] = [];
  for (const transfer of transfers) {
    ixs.push(
      getTransferCheckedInstruction(
        {
          source,
          mint: MINT,
          destination: await ata(transfer.payTo),
          authority: payer,
          amount: transfer.amount,
          decimals: DECIMALS,
        },
        { programAddress: TOKEN_PROGRAM_ADDRESS },
      ),
    );
  }
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    m => setTransactionMessageFeePayer(payer.address, m),
    m => appendTransactionMessageInstructions(ixs, m),
    m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
  );
  const signed = await partiallySignTransactionMessageWithSigners(tx);
  return getBase64EncodedWireTransaction(signed);
}

function batchRequirements(
  items: AtomicBatchItem[],
  overrides: Partial<PaymentRequirements> = {},
): PaymentRequirements {
  const total = items.reduce((sum, item) => sum + BigInt(item.amount), 0n).toString();
  return {
    scheme: "atomic-batch",
    network: SOLANA_DEVNET_CAIP2,
    asset: MINT,
    amount: total,
    payTo: items[0]?.payTo ?? "",
    maxTimeoutSeconds: 300,
    extra: { items },
    ...overrides,
  };
}

function batchPayload(transaction: string, accepted: PaymentRequirements): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: { transaction },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let payer: TransactionSigner;
let payee1: TransactionSigner;
let payee2: TransactionSigner;
let items: AtomicBatchItem[];
let facilitatorSigner: FacilitatorSvmSigner & {
  simulateTransaction: ReturnType<typeof vi.fn>;
  sendTransaction: ReturnType<typeof vi.fn>;
  confirmTransaction: ReturnType<typeof vi.fn>;
};

beforeEach(async () => {
  vi.clearAllMocks();
  accountBytes.clear();
  payer = await generateKeyPairSigner();
  payee1 = await generateKeyPairSigner();
  payee2 = await generateKeyPairSigner();
  items = [
    { payTo: payee1.address, amount: "60000" },
    { payTo: payee2.address, amount: "40000" },
  ];

  accountBytes.set(MINT, mintAccountBytes(DECIMALS));
  accountBytes.set(await ata(payer.address), tokenAccountBytes(MINT, payer.address));
  accountBytes.set(await ata(payee1.address), tokenAccountBytes(MINT, payee1.address));
  accountBytes.set(await ata(payee2.address), tokenAccountBytes(MINT, payee2.address));

  facilitatorSigner = {
    getAddresses: vi.fn(() => []),
    simulateTransaction: vi.fn(async () => {}),
    sendTransaction: vi.fn(async () => "mockSettlementSignature"),
    confirmTransaction: vi.fn(async () => {}),
  } as unknown as typeof facilitatorSigner;
});

// ---------------------------------------------------------------------------
// Facilitator
// ---------------------------------------------------------------------------

describe("AtomicBatchSvmScheme (facilitator)", () => {
  it("exposes scheme metadata: no fee payer extra, no signers", () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    expect(facilitator.scheme).toBe("atomic-batch");
    expect(facilitator.caipFamily).toBe("solana:*");
    expect(facilitator.getExtra(SOLANA_DEVNET_CAIP2)).toBeUndefined();
    expect(facilitator.getSigners(SOLANA_DEVNET_CAIP2)).toEqual([]);
  });

  it("rejects a mismatched scheme", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const requirements = batchRequirements(items, { scheme: "exact" });
    const result = await facilitator.verify(batchPayload("AAAA", requirements), {
      ...requirements,
      scheme: "exact",
    });
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrUnsupportedScheme);
  });

  it("rejects requirements without items", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const requirements = batchRequirements(items, { extra: {} });
    const result = await facilitator.verify(batchPayload("AAAA", requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrMissingItems);
  });

  it("rejects requirements whose amount is not the item sum", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const requirements = batchRequirements(items, { amount: "99999" });
    const result = await facilitator.verify(batchPayload("AAAA", requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrAmountSumMismatch);
  });

  it("rejects an undecodable transaction", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const requirements = batchRequirements(items);
    const result = await facilitator.verify(
      batchPayload("!!!not-a-transaction!!!", requirements),
      requirements,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrTransactionCouldNotBeDecoded);
  });

  it("rejects a v1 (SIMD-0385) wire transaction before decoding", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const requirements = batchRequirements(items);
    const v1Wire = getBase64Codec().decode(new Uint8Array([0x81, ...new Uint8Array(64)]));
    const result = await facilitator.verify(batchPayload(v1Wire, requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe("unsupported_transaction_version");
    expect(facilitatorSigner.simulateTransaction).not.toHaveBeenCalled();
  });

  it("verifies a valid two-item batch", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const transaction = await buildBatchTransaction(payer, [
      { payTo: payee1.address, amount: 60000n },
      { payTo: payee2.address, amount: 40000n },
    ]);
    const requirements = batchRequirements(items);
    const result = await facilitator.verify(batchPayload(transaction, requirements), requirements);
    expect(result.isValid).toBe(true);
    expect(result.payer).toBe(payer.address);
    expect(facilitatorSigner.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a transfer below the item amount", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const transaction = await buildBatchTransaction(payer, [
      { payTo: payee1.address, amount: 50000n },
      { payTo: payee2.address, amount: 40000n },
    ]);
    const requirements = batchRequirements(items);
    const result = await facilitator.verify(batchPayload(transaction, requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInsufficientAmount);
  });

  it("rejects a non-TransferChecked token instruction", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const source = await ata(payer.address);
    const plainTransfer = getTransferInstruction(
      {
        source,
        destination: await ata(payee1.address),
        authority: payer,
        amount: 60000n,
      },
      { programAddress: TOKEN_PROGRAM_ADDRESS },
    );
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      m => setTransactionMessageFeePayer(payer.address, m),
      m => appendTransactionMessageInstructions([plainTransfer], m),
      m => setTransactionMessageLifetimeUsingBlockhash(FAKE_BLOCKHASH, m),
    );
    const signed = await partiallySignTransactionMessageWithSigners(tx);
    const transaction = getBase64EncodedWireTransaction(signed);
    const requirements = batchRequirements([items[0]]);
    const result = await facilitator.verify(batchPayload(transaction, requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrInvalidBatch);
  });

  it("rejects when instruction count differs from item count", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const transaction = await buildBatchTransaction(payer, [
      { payTo: payee1.address, amount: 60000n },
    ]);
    const requirements = batchRequirements(items);
    const result = await facilitator.verify(batchPayload(transaction, requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrItemCountMismatch);
  });

  it("rejects when simulation fails", async () => {
    facilitatorSigner.simulateTransaction.mockRejectedValue(new Error("insufficient funds"));
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const transaction = await buildBatchTransaction(payer, [
      { payTo: payee1.address, amount: 60000n },
      { payTo: payee2.address, amount: 40000n },
    ]);
    const requirements = batchRequirements(items);
    const result = await facilitator.verify(batchPayload(transaction, requirements), requirements);
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe(Errors.ErrSimulationFailed);
  });

  it("settles a valid batch and reports the item total", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const transaction = await buildBatchTransaction(payer, [
      { payTo: payee1.address, amount: 60000n },
      { payTo: payee2.address, amount: 40000n },
    ]);
    const requirements = batchRequirements(items);
    const result = await facilitator.settle(batchPayload(transaction, requirements), requirements);
    expect(result.success).toBe(true);
    expect(result.transaction).toBe("mockSettlementSignature");
    expect(result.amount).toBe("100000");
    expect(result.payer).toBe(payer.address);
    expect(facilitatorSigner.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects a duplicate settlement of the same batch", async () => {
    const facilitator = new FacilitatorScheme(facilitatorSigner);
    const transaction = await buildBatchTransaction(payer, [
      { payTo: payee1.address, amount: 60000n },
      { payTo: payee2.address, amount: 40000n },
    ]);
    const requirements = batchRequirements(items);
    const payload = batchPayload(transaction, requirements);
    const first = await facilitator.settle(payload, requirements);
    expect(first.success).toBe(true);
    const second = await facilitator.settle(payload, requirements);
    expect(second.success).toBe(false);
    expect(second.errorReason).toBe(Errors.ErrDuplicateSettlement);
    expect(facilitatorSigner.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe("AtomicBatchSvmScheme (client)", () => {
  it("builds one signed transaction with exactly the batch transfers", async () => {
    const client = new ClientScheme(payer);
    const requirements = batchRequirements(items);
    const { payload } = await client.createPaymentPayload(2, requirements);
    const transaction = getTransactionDecoder().decode(
      getBase64Codec().encode((payload as { transaction: string }).transaction),
    );
    expect(transaction.signatures[payer.address]).toBeTruthy();
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    expect(compiled.header.numSignerAccounts).toBe(1);
    expect(compiled.instructions).toHaveLength(2);
    for (const ix of compiled.instructions) {
      expect(compiled.staticAccounts[ix.programAddressIndex]).toBe(TOKEN_PROGRAM_ADDRESS);
      expect(ix.data?.[0]).toBe(12); // TransferChecked
    }
    const amounts = compiled.instructions.map(ix =>
      new DataView(ix.data!.buffer, ix.data!.byteOffset + 1, 8).getBigUint64(0, true),
    );
    expect(amounts).toEqual([60000n, 40000n]);
  });

  it("throws when the requirements amount is not the item sum", async () => {
    const client = new ClientScheme(payer);
    const requirements = batchRequirements(items, { amount: "1" });
    await expect(client.createPaymentPayload(2, requirements)).rejects.toThrow(/sum_mismatch/);
  });
});

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

describe("AtomicBatchSvmScheme (server)", () => {
  it("derives amount and payTo from the items", async () => {
    const server = new ServerScheme();
    const requirements = batchRequirements(items, { amount: "0", payTo: "" });
    const enhanced = await server.enhancePaymentRequirements(
      requirements,
      { x402Version: 2, scheme: "atomic-batch", network: SOLANA_DEVNET_CAIP2 },
      [],
    );
    expect(enhanced.amount).toBe("100000");
    expect(enhanced.payTo).toBe(payee1.address);
    expect(enhanced.extra?.items).toEqual(items);
  });

  it("parses an itemized AssetAmount price to the item sum", async () => {
    const server = new ServerScheme();
    const parsed = await server.parsePrice(
      { amount: "0", asset: MINT, extra: { items } },
      SOLANA_DEVNET_CAIP2,
    );
    expect(parsed.amount).toBe("100000");
    expect(parsed.asset).toBe(MINT);
  });

  it("rejects a bare Money price without a parser", async () => {
    const server = new ServerScheme();
    await expect(server.parsePrice("$1.00", SOLANA_DEVNET_CAIP2)).rejects.toThrow(/itemized/);
  });
});
