---
"@x402/svm": patch
---

Recover batch claims, distribution and close transactions without changing the distribution request. Preserve signed transaction identity before submission, constrain account reads to the confirmation slot, and report actual transaction payouts consistently on recovery. New distribution transactions use distinct memos even when they share a blockhash. The merchant channel manager reconciles its paid watermark through a confirmed account read rather than assuming a recovered response paid the newest claim.

The default recovery store is process-local. Shared deployments can supply atomic, durable storage and an idempotent payout-recording callback. Unresolved transactions retain their identity instead of silently expiring into replacement broadcasts.
