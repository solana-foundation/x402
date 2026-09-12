# Batch transaction recovery

Distribution retains its existing request: `type: "settle"` and channels with `channelId` and `channelConfig`. Do not send payout watermarks or a payout idempotency key. The request asks to distribute what is owed; a later retry may also sweep newly claimed earnings.

The SDK records signed bytes and their signature before sending. A retry reconciles that signature and may resend the identical bytes. Unknown outcomes remain `settlement_pending`; neither a timeout nor unavailable transaction history proves expiration or failure. No replacement transaction is built while that outcome is unresolved. Confirmed account reads use the transaction's execution slot as `minContextSlot` where the signer supplies it.

The merchant channel manager reads the confirmed channel payout watermark after distribution. A recovered response may identify an older sweep, so success alone does not mark a newer local claim as paid. Configure `rpcUrl` or `readPayoutWatermark` for the merchant’s RPC transport. A stale, missing or unavailable account read leaves outstanding work for a later pass.

Distribution `amount` describes the actual receiver token credit in the identified transaction. A recovered response returns that same amount. Consumers deduplicate by network, transaction, asset and recipient, rather than summing HTTP responses. The optional `onDistributionConfirmed` callback runs before recovery completion and may run more than once; its implementation must be idempotent. If recording fails, the original signature stays pending.

`InMemoryBatchPendingSettlementStore` is a single-process reference implementation. It does not survive restarts. Persistent implementations must retain unresolved records and implement `setIfAbsent` and `deleteIfEquals` atomically across processes. Operators must also serialize overlapping distribution batches through a shared worker or lease; these record primitives do not provide a distributed scheduler. Stores without that method support only local serialization. Completed result retention is an operator policy; losing a record never establishes a previous operation's identity. Do not configure a TTL that silently deletes unresolved transactions.

Custom signers should return the execution slot from `confirmTransaction`, honor `minContextSlot`, and implement `getConfirmedTransaction` with confirmed token-balance metadata. The default adapter implements these capabilities. Missing metadata returns pending with the original signature, not an estimated payout.

A limitation remains when closing a channel whose receiver is also the refund recipient or protocol treasury: aggregate token balances can combine merchant earnings with a refund or treasury sweep. The SDK keeps that operation pending for reconciliation rather than reporting the combined amount as merchant earnings. Ordinary separate customer and merchant wallets are unaffected. This is an attribution limitation; the transaction may already have completed and must not be repeated as a replacement payment.

## RPC and latency budget

The ordinary metered-request server path is unchanged. Fresh channel transactions capture the execution slot from their existing confirmation call, with no additional successful confirmation lookup. Older-history status searches are opt-in for recovery, not enabled for every fresh confirmation across other schemes.

Distribution uses one confirmed-transaction metadata read per new payout (retried when indexing lags). This replaces the facilitator’s former post-distribution per-channel checks; the merchant manager separately reads the paid watermark per channel before updating its records. Run redemption outside the inference request path. Channel opening/top-ups still await recovery storage before broadcast; the reference store is in memory, while durable adapters add storage latency. The first recovered receipt after client restart can require a mint read and local state hydration.

Postcondition/metadata polling makes up to five attempts, with 200/400/800/1600 ms backoff: up to three seconds of sleep plus RPC time in that loop. There is no artificial delay on a successful first read. These are code-level call counts, not a measured production latency benchmark.
