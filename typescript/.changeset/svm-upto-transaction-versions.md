---
"@x402/svm": minor
---

Negotiate the Solana transaction message version for the `upto` scheme and the shared payment-channels open transaction.

- The `upto` facilitator advertises `extra.transactionVersions` (`[0]`) in `/supported`; the server forwards it in the challenge.
- The `upto` client builds one of the advertised versions via `resolveTransactionVersion` and refuses with `unsupported_transaction_version` when version 0 is not among them.
- `verifyOpenTransaction` and the `upto` settlement simulation reject any message version other than legacy or 0 with `unsupported_transaction_version` before inspecting the instruction layout.
- Facilitator-built claim and reclaim transactions use transaction v1 independently of the client's open version, with explicit inline compute and loaded-account-data limits.
- Rent cleanup greedily packs reclaim instructions to the v1 4,096-byte wire, 64-account, and 64-instruction ceilings instead of using a fixed batch size.
