# Scheme: `atomic-batch`

## Summary

`atomic-batch` is a payment scheme in which a client settles **several
payments to several recipients in one atomic on-chain transaction**,
authorized by a **single client signature**. Verification and settlement
happen in a single pass, exactly as in [`exact`](../exact/scheme_exact.md):
the facilitator validates the signed transaction, broadcasts it, and value
has moved. There is no escrow, no channel, no voucher, and no deferred
redemption.

The scheme exists for machine-to-machine commerce, where one logical
operation routinely owes value to many parties at once — a marketplace
split, a data purchase with a referrer share, an agent paying its tools.
With `exact`, that operation costs N transactions, N signatures, and N
settlement round-trips. With `atomic-batch` it costs one of each, and the
payments succeed or fail **together**: no recipient can be paid while
another is skipped.

The batch is single-asset: every payment in a batch transfers the same
asset. The set of payments is fixed when the client builds the transaction
and is enumerated in the payment requirements (see the network binding for
how the set is carried), so the facilitator verifies the signed bytes
against an explicit, itemized expectation — never against the client's
say-so alone.

`atomic-batch` is **not** a variant of
[`batch-settlement`](../batch-settlement/scheme_batch_settlement.md). The
two schemes batch along different axes:

| | `batch-settlement` | `atomic-batch` |
|---|---|---|
| Batches | many requests over time | many recipients in one request |
| Settlement timing | deferred (commit → accumulate → redeem) | immediate, in the request pass |
| Client commitment | voucher / channel / credit line | a fully signed transaction |
| Trust anchor | client's escrowed capital or a network intermediary | the transaction itself |
| Atomicity | eventual, per accumulated batch | all-or-nothing, on-chain |

A network binding for `atomic-batch` MUST define how the transaction
achieves multi-recipient settlement natively on that network. The SVM
binding ([`scheme_atomic_batch_svm.md`](scheme_atomic_batch_svm.md)) uses a
single Solana transaction carrying one token transfer per recipient.

## Use Cases

**Marketplace and revenue splits.** A sale owes the seller, the platform,
and a referrer in one step. One signature settles all three shares
atomically; the split can never half-execute.

**Agent tool payments.** An agent completing one task pays several tool or
data providers whose outputs it combined. A single batch keeps the
agent's accounting 1:1 with the task and leaves one on-chain transaction
as the receipt for the whole operation.

**Payroll and disbursement.** A service disburses the same asset to a
small set of recipients on a schedule. Each disbursement is one
transaction with one confirmation, instead of one transaction per payee.

**Bundled purchases with fees.** A purchase that carries a protocol or
facilitator fee as a separate line item pays the merchant and the fee
recipient in the same transaction, so the fee provably matches the sale.

## Protocol behavior

1. The resource server responds to a request with `PaymentRequired`
   containing an `accepts` entry for scheme `atomic-batch`. The entry
   enumerates **every** payment in the batch (recipient + amount per item)
   in the manner defined by the network binding, and states the single
   `asset` all items share. `amount` at the top level is the sum of the
   item amounts.
2. The client builds **one** transaction that effects exactly the
   enumerated payments — no more, no fewer — signs it once, and returns it
   as the `PaymentPayload`.
3. The facilitator verifies the payload: the signature is valid, the
   transaction effects every enumerated payment of at least the required
   amount to the required recipient of the required asset, it effects
   **no other** value transfer, and it is within its validity window.
   Verification MUST be performed against the requirements, re-derived
   from the signed bytes; any auxiliary data the client echoes (such as a
   plan identifier) is advisory and MUST NOT be trusted.
4. The facilitator settles by broadcasting the one transaction. On
   success, the settlement response carries the single transaction
   identifier, from which every item's settlement derives. Items are
   settled together or not at all; partial settlement results do not
   exist in this scheme.

### Roles and fees

The client is the payer for every item. Whether the client also pays the
network transaction fee, or a sponsor co-signs as fee payer, is defined by
the network binding. The facilitator MUST NOT be an authority over any
payment in the batch and MUST NOT be able to alter amounts, recipients, or
the asset; its role is verification and broadcast only (non-custodial).

### Batch limits

Network bindings MUST state a maximum item count (bounded by the
network's transaction size limits) and MUST reject batches with zero
items, duplicate items, or non-positive amounts.

## Security considerations

- **Replay.** A settled batch transaction MUST NOT be settleable twice.
  Facilitators SHOULD track settled transaction identifiers (or message
  hashes) for at least the transaction's validity window and reject
  duplicates. Network validity windows (e.g. blockhash expiry) bound
  replay to that window.
- **Authorization scope.** The client's single signature authorizes
  exactly the transfers in the transaction. Strict verification — an
  allowlist over what the transaction may contain, defined by the network
  binding — is what keeps that scope exact: any instruction, transfer, or
  authority outside the enumerated batch invalidates the payload.
- **Settlement atomicity.** All items settle in one transaction, so the
  scheme has no partial-payment state to reconcile. A failed broadcast
  settles nothing.
- **Plan/quote binding.** If a binding offers a facilitator-built quote or
  plan step, the plan is a convenience for construction only. Verification
  MUST re-derive every checked property from the signed transaction and
  the requirements.

## Appendix

### Network requirements

Every `atomic-batch` network binding MUST specify:

1. **Item enumeration** — how the batch's payments (recipient, amount)
   are enumerated in `PaymentRequirements`, and how the top-level
   `amount` relates to the items (it MUST equal their sum).
2. **Payload format** — the structure and encoding of the payment
   payload, including how the signed transaction is carried.
3. **Verification rules** — signature validation, the exact allowlist of
   permitted transaction contents, per-item matching (asset, recipient,
   minimum amount), duplicate-item rejection, and validity-window checks.
4. **Fee model** — who pays the network fee, and what signatures beyond
   the client's are required, if any.
5. **Settlement** — how the transaction is broadcast and confirmed, what
   the settlement response contains, and how duplicate settlement is
   prevented.
6. **Limits** — maximum items per batch and any per-item constraints.

### Related schemes

[`exact`](../exact/scheme_exact.md) — one payment to one recipient,
settled immediately. `atomic-batch` is `exact` generalized along the
recipient axis.

[`batch-settlement`](../batch-settlement/scheme_batch_settlement.md) —
many requests over time, settled later in aggregate. `atomic-batch`
settles immediately and does not defer.

[`upto`](../upto/scheme_upto.md) — one recipient, variable amount up to an
authorized maximum.
