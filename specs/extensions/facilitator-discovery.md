# Extension: `facilitator-discovery`

## Summary

x402 standardizes how a client pays through a facilitator, but not how an
agent **finds** one. Today, facilitator endpoints are configured by hand,
out of band, which does not work for machine-to-machine commerce: an
agent that wants to pay — or to settle through a different facilitator
than its default — has no standard way to learn what facilitators exist,
which networks and schemes they serve, or where their endpoints live.

The `facilitator-discovery` extension defines three publication surfaces
a facilitator MAY provide:

1. A **discovery document** at the well-known URI
   `/.well-known/x402-facilitator`, describing the facilitator and its
   endpoints.
2. A **registry** endpoint listing other facilitators the operator
   knows, so discovery can bootstrap from any one facilitator to the
   network of them.
3. **Public settlement receipts and aggregate statistics**, so agents can
   evaluate a facilitator's liveness and volume before trusting it with
   traffic.

It also defines a minimal **federation** convention: a settle request
may name another facilitator to settle through, and receipts record the
chain of facilitators involved.

This extension is the `x402m-facilitator-discovery-v0` profile in
production at the Musebook facilitator, generalized here. It complements
the [`bazaar`](bazaar.md) extension: Bazaar is discovery of paid
*resources*; this is discovery of settlement *infrastructure*.

---

## Discovery document

A facilitator implementing this extension MUST serve a JSON document at:

```
GET /.well-known/x402-facilitator
```

Example (from the reference deployment):

```json
{
  "x402m": "v0",
  "x402Version": 2,
  "id": "musebook",
  "operator": "clawd",
  "description": "Non-custodial x402 facilitator with single-signature batch settlement (x402m meta protocol)",
  "endpoints": {
    "supported": "https://musebook.trade/api/x402/supported",
    "pricing": "https://musebook.trade/api/x402/pricing",
    "verify": "https://musebook.trade/api/x402/verify",
    "settle": "https://musebook.trade/api/x402/settle",
    "batchPlan": "https://musebook.trade/api/x402/batch/plan",
    "batchVerify": "https://musebook.trade/api/x402/batch/verify",
    "batchSettle": "https://musebook.trade/api/x402/batch/settle",
    "batchSettleMulti": "https://musebook.trade/api/x402/batch/settle-multi",
    "receipts": "https://musebook.trade/api/x402/receipts",
    "pulse": "https://musebook.trade/api/x402/pulse",
    "facilitators": "https://musebook.trade/api/x402/facilitators",
    "agents": "https://musebook.trade/api/x402/agents"
  },
  "networks": [
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    "eip155:8453",
    "eip155:84532"
  ],
  "extensions": ["x402m-batch-v0", "x402m-receipts-v0", "x402m-referral-v0"]
}
```

### Fields

| Field | Required | Description |
|---|---|---|
| `id` | yes | Short stable identifier for the facilitator, unique within a registry. Used by federation (`forwardTo`) and receipts. |
| `operator` | no | Human- or agent-readable name of the operating entity. |
| `description` | no | Free-text summary of the facilitator's distinguishing features. |
| `x402Version` | no | Highest x402 protocol version the facilitator serves. |
| `endpoints` | yes | Map of capability name → absolute URL. `supported`, `verify`, and `settle` are the standard x402 facilitator endpoints; additional keys advertise extension endpoints. Consumers MUST ignore keys they do not recognize. |
| `networks` | yes | CAIP-2 network identifiers the facilitator settles on. |
| `extensions` | no | Extension identifiers the facilitator implements, e.g. the `atomic-batch` scheme profile `x402m-batch-v0`. |

Deployments MAY include additional fields (the reference deployment adds
`launchpad` and `registry` links); consumers MUST ignore unknown fields.
The document is a *claim*, not a proof: consumers SHOULD cross-check the
`supported` endpoint (which is authoritative for schemes and signers)
before routing payments.

---

## Registry

A facilitator SHOULD serve its known-facilitator registry at the URL
advertised as `endpoints.facilitators`:

```
GET  /api/x402/facilitators        → list of discovery documents (or references to them)
POST /api/x402/facilitators        → register a facilitator by its well-known URL
```

- Registration is by URL: the registrant submits the URL of its own
  discovery document; the registry operator fetches and indexes it.
- The registry is **public read**: any agent can enumerate known
  facilitators with their networks and extensions and choose one
  machine-to-machine, with no human in the loop.
- Registry entries are claims by their operators. A registry MUST NOT
  mark an entry as verified unless it has independently checked the
  discovery document and `supported` endpoint.

Facilitators that are also registered agents in a directory (the
reference deployment registers facilitators as agents with a
`facilitator` capability) MAY be discovered through that directory
instead; the registry endpoint remains the portable surface.

---

## Federation

Any settle-family request body MAY include:

```json
{ "forwardTo": "<facilitator-id>" }
```

- The receiving facilitator settles via the named facilitator and
  returns the target's settlement result.
- Receipts (below) record both facilitators: `facilitator` (the
  settling facilitator) and `forwardedBy` (the facilitator that received
  the request), so cross-facilitator volume can be aggregated honestly
  by third parties.
- A facilitator that cannot reach the named target MUST fail the
  request rather than silently settling locally.

---

## Public receipts and pulse

A facilitator implementing the receipts profile MUST publish every
settlement as a public receipt, unless the settlement request opted out
(`"private": true` in the reference deployment's batch API):

```
x402:receipt:<tx-signature> = {
  ts, network, facilitator, batch: true|false,
  payer, items: [{ payTo, asset, amount }], tx, ref?
}
```

- `GET /api/x402/receipts?limit=50` — the facilitator's public payment
  tape, newest first.
- `GET /api/x402/pulse` — trailing-24h aggregates: settlement count,
  batch settlement count, total volume in base units, top payer→payee
  pairs, and top referrers where referral attribution is in use.

Receipts make facilitator claims *auditable*: the discovery document
says what a facilitator does; the receipt tape shows what it has done.
Receipt contents are derived from on-chain settlement data and can be
independently verified against the transaction signature.

This profile is distinct from the
[`offer-and-receipt`](extension-offer-and-receipt.md) extension, which
exchanges offer and receipt data between the transacting parties inside
the payment flow. Public receipts are a facilitator publication surface
for third parties — agents evaluating facilitators, indexers, and
leaderboards.

---

## Security considerations

- **Discovery is not trust.** A discovery document or registry entry is
  an operator's claim. Agents SHOULD verify the `supported` endpoint,
  prefer facilitators with a public receipt history consistent with
  on-chain data, and treat unknown facilitators as untrusted with value.
- **Non-custodial invariant.** Nothing in this extension changes x402's
  settlement trust model: a conforming facilitator verifies and relays
  client-signed payments; discovery MUST NOT be used to route a payer's
  signing material anywhere.
- **Privacy.** Public receipts expose payer, payees, amounts, and
  timing. Facilitators MUST honor the opt-out for settlements that
  request it, and agents paying through a receipts-publishing
  facilitator should assume settlements are public by default.
- **Endpoint integrity.** Discovery documents SHOULD be served over
  HTTPS from the facilitator's canonical domain; registries SHOULD
  record the URL a document was fetched from so impersonation is
  detectable.
