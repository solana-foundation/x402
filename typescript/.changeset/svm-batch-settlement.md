---
"@x402/svm": minor
---

Added a reference implementation of the SVM `batch-settlement` scheme — high-throughput channel payments where a client deposits once into a long-lived payment channel, signs cumulative Ed25519 vouchers verified off-chain (no per-request transaction), and the operator redeems the latest voucher per channel on-chain in batches. Reuses the `upto` payment-channels program, 48-byte voucher, and SOL-drain-guarded open co-sign. Ships client (`./batch-settlement/client`), resource-server (`./batch-settlement/server`), and facilitator (`./batch-settlement/facilitator`) entry points with an in-memory channel store, off-chain voucher acceptance, and operator-driven `settleBatch`/`distribute`. Also adds the watermark-only `settle` payment-channels instruction.
