---
"@x402/svm": minor
---

Add the `atomic-batch` payment scheme for SVM: multi-recipient payments in a single Solana transaction (client, server, and facilitator implementations), where the client signs once as fee payer and sole signer and the facilitator verifies every item against the signed transaction before broadcasting it unchanged.
