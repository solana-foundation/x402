---
"@x402/svm": minor
---

Negotiate the Solana transaction message version for the `upto` scheme and the shared payment-channels open transaction.

- The `upto` facilitator advertises `extra.transactionVersions` (`[0]`) in `/supported`; the server forwards it in the challenge.
- The `upto` client builds one of the advertised versions via `resolveTransactionVersion` and refuses with `unsupported_transaction_version` when version 0 is not among them.
- `verifyOpenTransaction` and the `upto` settlement simulation reject any message version other than legacy or 0 with `unsupported_transaction_version` before inspecting the instruction layout.
