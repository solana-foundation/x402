# Scheme: `atomic-batch` `SVM`

## Summary

This document specifies the `atomic-batch` scheme (see
[`scheme_atomic_batch.md`](scheme_atomic_batch.md)) on Solana Virtual
Machine (SVM) networks.

The client builds **one** Solana transaction containing one SPL Token
`TransferChecked` instruction per payment in the batch, signs it **once**
as fee payer and sole signer, and submits it as the payment payload. The
facilitator verifies the signed transaction against the itemized
requirements — strict instruction allowlist, per-item asset / recipient /
amount matching — then broadcasts the same transaction. All payments
settle atomically in that single transaction, or none do.

This binding differs from the SVM `exact` binding in one structural way:
in `exact`, the facilitator (or merchant) sponsors fees and adds the
final `feePayer` signature to a partially signed transaction. In
`atomic-batch` the payer **is** the fee payer and the transaction arrives
fully signed; the facilitator never signs. Single-signature settlement is
the defining property of the scheme, and fee sponsorship would require a
second required signature. (A deployment MAY layer sponsorship on top out
of band; it is not part of this scheme.)

**Reference deployment.** This binding is implemented and running in
production by the Musebook facilitator on Solana mainnet and devnet
(x402 v2, alongside v1/v2 `exact`), where it additionally exposes
facilitator-assisted construction endpoints (`/api/x402/batch/plan`,
`/batch/verify`, `/batch/settle`). The plan step is a construction
convenience only; the scheme semantics below are the portable contract.

## Payment payload

### `PaymentRequirements`

In addition to the standard x402 `PaymentRequirements` fields, the
`atomic-batch` SVM binding carries the batch in `extra.items`:

```json
{
  "scheme": "atomic-batch",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "amount": "350000",
  "payTo": "9xQeVvXkGbz9eKjTa2vXnPqR7sW4dFhJmNcB3aZ6yU",
  "maxTimeoutSeconds": 90,
  "extra": {
    "items": [
      { "payTo": "9xQeVvXkGbz9eKjTa2vXnPqR7sW4dFhJmNcB3aZ6yU", "amount": "250000" },
      { "payTo": "4Nd1mPzQk8sVbT2xW7rYcA5eHfJgKdL9nB3vX6sZaQ", "amount": "100000" }
    ]
  }
}
```

- `asset`: the SPL Token mint every item pays. A batch is single-asset.
- `extra.items`: 1–8 entries of `{ payTo, amount }`, where `payTo` is the
  recipient's wallet address (not a token account) and `amount` is in the
  asset's base units as a decimal string. Entries MUST NOT repeat a
  `payTo`, and every amount MUST be > 0.
- `amount` (top level): MUST equal the sum of the item amounts.
- `payTo` (top level): MUST equal `extra.items[0].payTo`. It is carried
  for core-schema compatibility only; verifiers MUST treat
  `extra.items` as authoritative and MUST NOT settle based on the
  top-level `payTo` alone.

### `PaymentPayload`

```json
{
  "x402Version": 2,
  "accepted": { "...": "the PaymentRequirements above" },
  "payload": {
    "transaction": "<base64-encoded signed transaction>"
  }
}
```

`payload.transaction` is the base64-encoded, **fully signed** transaction
described below.

### Transaction construction (client)

The client MUST construct a transaction (legacy or v0) such that:

1. The message header requires **exactly one signature**. Account index
   0 is the payer: fee payer, transfer authority, and sole signer.
2. The instructions are **exactly** the batch's transfers — one
   instruction per item, in the same order as `extra.items` — and
   nothing else. In particular, the transaction MUST NOT contain
   compute-budget, memo, or associated-token-account creation
   instructions. (Consequence: every recipient's token account for the
   asset MUST already exist. Clients and servers agree on this out of
   band; in the reference deployment, plan construction fails with
   `payee_missing_token_account` when one does not.)
3. Each instruction is a `TransferChecked` (instruction discriminant 12)
   on the SPL Token program (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`):
   - `source`: a token account owned by the payer holding the asset
     (the payer's associated token account in the reference client);
   - `mint`: `PaymentRequirements.asset`;
   - `destination`: the associated token account of the item's `payTo`
     for the asset;
   - `authority`: the payer (account index 0);
   - `amount`: at least the item's required amount;
   - `decimals`: the mint's decimals.
4. The transaction's blockhash is recent (within its normal validity
   window). The client signs the transaction with the payer key,
   producing exactly one signature.

Token-2022 mints are out of scope for this version of the binding; the
allowlist names the classic SPL Token program only.

## Verification

The facilitator MUST verify all of the following, re-derived from the
signed transaction bytes and the `PaymentRequirements`. A facilitator
that offers a plan/construction step MUST NOT trust the echoed plan; the
checks below are the whole contract.

1. **Scheme and network.** `scheme` is `atomic-batch` and the network is
   an SVM network the facilitator serves, else
   `invalid_atomic_batch_svm_unsupported_network`.
2. **Decodability.** The payload decodes as a Solana transaction, else
   `invalid_atomic_batch_svm_payload_transaction_could_not_be_decoded`.
   The message is a legacy or version 0 message; other versions
   (including v1, SIMD-0385) are rejected with
   `unsupported_transaction_version`.
3. **Signature.** The message header requires exactly one signature; the
   signature at index 0 is present and is a valid Ed25519 signature by
   account 0 over the message bytes, else
   `invalid_atomic_batch_svm_payload_missing_signatures` /
   `invalid_atomic_batch_svm_payload_signature_invalid`.
4. **Payer position.** Every transfer's `authority` is account index 0
   (the payer, who is also fee payer), else
   `invalid_atomic_batch_svm_payload_authority_not_payer`.
5. **Strict instruction allowlist.** The number of instructions equals
   the number of items, and **every** instruction is a `TransferChecked`
   on the SPL Token program, else
   `invalid_atomic_batch_svm_payload_invalid_batch`. No other program,
   and no other token instruction, may appear.
6. **Per-item matching.** For each instruction *i* against
   `extra.items[i]`:
   - `mint` equals `PaymentRequirements.asset`, else
     `invalid_atomic_batch_svm_payload_wrong_asset`;
   - the `decimals` byte equals the mint's decimals, else
     `invalid_atomic_batch_svm_payload_wrong_decimals`;
   - `amount` is at least the item's amount, else
     `invalid_atomic_batch_svm_payload_insufficient_amount`;
   - `destination` equals the item `payTo`'s associated token account
     for the asset, else
     `invalid_atomic_batch_svm_payload_destination_mismatch`;
   - `destination` is a token account whose owner is the item's
     `payTo` (verified on-chain; the derived-address check alone is not
     sufficient if the account could have been created for another
     owner), else `invalid_atomic_batch_svm_payload_wrong_recipient`;
   - `source` is a token account owned by the payer holding the asset,
     else `invalid_atomic_batch_svm_payload_source_mismatch`;
   - no two instructions share the same `(destination, amount)` pair,
     else `invalid_atomic_batch_svm_payload_duplicate_item`.
7. **Item count.** The instruction count equals the item count, else
   `invalid_atomic_batch_svm_payload_item_count_mismatch`.
8. **Simulation.** The facilitator simulates the transaction (with
   signature verification off, since step 3 already verified the only
   signature locally) and simulation succeeds. Simulation is the
   executability check: it confirms the payer's source balance covers
   the total and that the transaction's blockhash has not expired. On
   failure: `invalid_atomic_batch_svm_transaction_simulation_failed`.

On success the facilitator returns a `VerifyResponse` with
`isValid: true` and `payer` set to account 0.

## Settlement

1. The facilitator re-runs verification; an invalid payload MUST NOT be
   settled.
2. **Duplicate protection.** Before broadcasting, the facilitator checks
   a settlement cache keyed by the transaction's message hash. A batch
   whose message hash was already settled (or is in flight) MUST be
   rejected with `duplicate_settlement`. Cache entries SHOULD be kept
   for at least the blockhash validity window (~2 minutes).
3. The facilitator broadcasts the transaction **unchanged** — it adds no
   signature and modifies no bytes — and waits for confirmation at
   `confirmed` commitment or better.
4. On confirmation it returns a `SettleResponse`:

```json
{
  "success": true,
  "transaction": "<transaction signature>",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "<payer address>"
}
```

   The one transaction signature settles every item; there is no
   per-item settlement state. If broadcast succeeds but confirmation
   times out, the facilitator MAY return success with the transaction
   signature and reconcile asynchronously, as in the SVM `exact`
   binding's pending-settlement pattern.

## Appendix

### Relation to facilitator-assisted construction

The reference deployment offers `POST /api/x402/batch/plan`, in which the
facilitator resolves token accounts, checks the payer's balance, builds
the unsigned transaction, and returns it with a plan id and an expiry
(90 s). This is an optimization of step "Transaction construction" for
clients without Solana tooling; it changes no verification semantics.
The returned plan id is `x402m:plan:<hash of the unsigned transaction>`.

### Multi-payer aggregation (informative)

The reference deployment also exposes `POST /api/x402/batch/settle-multi`,
which accepts several independent x402 payment envelopes (atomic-batch
payloads from different payers, and EVM `exact` authorizations), verifies
and settles each through the standard per-scheme flow, and returns one
aggregated response. Aggregation is a facilitator composition, not part
of this scheme: each envelope is verified and settled under its own
scheme's rules.

### Error reasons

Verification and settlement failures use the reason strings enumerated
in Verification above, prefixed `invalid_atomic_batch_svm_`, plus
`duplicate_settlement` for repeats — mirroring the naming convention of
the SVM `exact` binding so facilitators can share error handling.
