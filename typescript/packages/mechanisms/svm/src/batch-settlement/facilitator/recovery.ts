/* eslint-disable jsdoc/require-jsdoc */
import type { PendingSettlementStore } from "@x402/core/facilitator";

/** Batch recovery records must outlive an unresolved transaction. */
export interface BatchPendingSettlementStore extends PendingSettlementStore {
  /** Atomically reserve an operation before sending. Required across processes. */
  setIfAbsent?(key: string, value: string): Promise<boolean>;
  /** Remove only this transaction, preserving a successor reserved by another worker. */
  deleteIfEquals?(key: string, value: string): Promise<boolean>;
}

/** Reference store: process-local recovery, with no eviction of unresolved work. */
export class InMemoryBatchPendingSettlementStore implements BatchPendingSettlementStore {
  private readonly records = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.records.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.records.set(key, value);
  }

  async setIfAbsent(key: string, value: string): Promise<boolean> {
    if (this.records.has(key)) return false;
    this.records.set(key, value);
    return true;
  }

  async deleteIfEquals(key: string, value: string): Promise<boolean> {
    if (this.records.get(key) !== value) return false;
    this.records.delete(key);
    return true;
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }
}

const distributionPasses = new WeakMap<
  PendingSettlementStore,
  Map<string, Promise<import("@x402/core/types").SettleResponse>>
>();

export function distributionsForStore(store: PendingSettlementStore) {
  let passes = distributionPasses.get(store);
  if (!passes) distributionPasses.set(store, (passes = new Map()));
  return passes;
}

// Coalesce before any awaits, including when two schemes share a local store.
const reservations = new WeakMap<PendingSettlementStore, Map<string, Promise<boolean>>>();

/**
 * Reserve through the store, or serialize legacy stores within this process.
 *
 * @param store - Replaceable recovery storage
 * @param key - Operation being reserved
 * @param signature - Locally derived transaction identity
 * @returns Whether this caller owns the first broadcast
 */
export async function reserveBroadcast(
  store: BatchPendingSettlementStore,
  key: string,
  signature: string,
): Promise<boolean> {
  if (store.setIfAbsent) return store.setIfAbsent(key, signature);
  let pending = reservations.get(store);
  if (!pending) reservations.set(store, (pending = new Map()));
  const previous = pending.get(key) ?? Promise.resolve(false);
  const next = previous
    .catch(() => false)
    .then(async () => {
      if (await store.get(key)) return false;
      await store.set(key, signature);
      return true;
    });
  pending.set(key, next);
  try {
    return await next;
  } finally {
    if (pending.get(key) === next) pending.delete(key);
  }
}
