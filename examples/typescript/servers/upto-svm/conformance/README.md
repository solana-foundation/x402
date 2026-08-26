# upto-svm × Settlement-Receipt Binding — conformance demonstration

Shows that an SVM `upto` settlement — exactly what `UptoSvmFacilitatorScheme.settle()`
returns — binds to a **recomputable SEP-2828 receipt** under the x402
[Settlement-Receipt Binding extension](https://github.com/x402-foundation/x402/pull/2666),
and that an independent party can verify the whole link **offline, with no trust in
the facilitator**.

## Run

```bash
pip install rfc8785 cryptography
python emit.py                 # build the vector from sample-settle-output.json
python _check_independent.py   # the pinned independent checker -> exit 0
```

`_check_independent.py`'s four verdict functions are byte-identical to the pinned
`vaaraio/vaara` `v1.1.1` (`088a869`) checker; only `_RAILS = ("svm",)`, the
docstring, and a "run emit.py first" guard differ. It imports neither x402 nor
this repo — only `rfc8785` (JCS) and `cryptography` (ES256).

## What it maps to in `upto-svm`

`emit.py` consumes exactly what the facilitator emits (`sample-settle-output.json`):

| `upto-svm` `settle` | → | settlement record |
| --- | --- | --- |
| `settleResponse.transaction` (settle_and_seal + distribute sig) | → | step1 executed settlement id |
| `settleResponse.amount` | → | actual metered amount |
| `requirements.maxAmount` (signed ceiling) | → | `authorizedCeiling`; refund = ceiling − actual |
| receiver-authorizer `voucher` | → | step0 in-progress assertion |

## What it proves (offline, no facilitator trust)

- **`action_ref_recomputes`** — the join key is `sha256(JCS({agentId, actionType, scope, timestampMs, seq, terminal}))`. No amount in it.
- **`settlement_binding_resolves`** — the receipt's `evidenceRef.digest` = `sha256(JCS(settlement))`.
- **`receipt_signature_ok`** — ES256 verifies.
- **`lifecycle_distinguishes_terminal`** — step0 (in-progress) and step1 (terminal) have distinct join keys; a mid-task receipt can't be passed off as final.

And the two reasons `upto` is the sharp case, which fall out of the above:

1. **Bind the finalized result, not the voucher.** step0 binds `assertedFrom: receiver-authorizer-voucher` (an assertion); step1 binds `assertedFrom: net-balance-change-to-payTo` after `settle_and_seal`/`distribute`. The two are signed by *different* seats — the receiver authorizer holds payment authority over vouchers, the fee payer holds lifecycle authority and can seal an abandoned channel with `has_voucher = 0` — so the voucher alone doesn't determine what settled.
2. **Amount/ceiling out of the join key.** A receipt issued against the **5.00 USDC ceiling** binds to a **1.20 USDC actual** settlement, because amount never enters the tuple.

## Honest scope

- `sample-settle-output.json` is a **fixture** — every Solana pubkey/signature is a placeholder. Drop in a **real devnet `settle` output** and it becomes an on-chain-anchored, third-rail conformance vector (the same way the `sui` vector is anchored to a live testnet `exact` settlement).
- The receipt is signed with a **throwaway demo key** (`keys/`, regenerated each run) only to exercise the checker. In the conformance set the receipt is signed by the SEP-2828 issuer.
- Passing the checker proves recompute + binding. It does **not** bind `backLink` to a live attestation instance — that's out of scope (see the extension's §5 non-goals).
