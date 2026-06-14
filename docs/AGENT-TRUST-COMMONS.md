# Agent Trust Commons — Manifesto & Open Standard (v0.1 draft)

*A neutral public good for the agent economy, operated by the [x402 Trust Layer](https://x402trustlayer.xyz). Live hub: [/commons](https://x402trustlayer.xyz/commons).*

---

## 1. The problem

In 2026 every serious player is building its **own** agent-trust silo:

- **Visa** — Agent Score + Agentic Registry + Large Transaction Model
- **Mastercard** — Agent Pay for Machines
- **Skyfire** — verified agent identity credential
- **Kite** — SPACE identity framework
- **Ethereum** — ERC-8004 identity & reputation registries
- **x402 / AP2 / MPP** — competing payment protocols

None of these talk to each other. A Skyfire-verified agent is invisible to a Kite merchant. An ERC-8004 score can't be read inside a Visa flow. Trust is **fragmented**, and fragmentation is exactly what fraud thrives on.

## 2. The idea — be Switzerland, not a competitor

The Commons does **not** issue its own competing identity or score and try to win. It is the **neutral hub** that *unifies* every network's signal into one verifiable passport, so an agent trusted anywhere is recognized everywhere.

> We compete with none of them. We connect them all.

This only works if the operator is **independent** — Visa will never display Mastercard's score; only a neutral third party can show them side by side. Being small and unaligned is the *advantage* here, not a weakness.

## 3. Why every participant benefits (no one is threatened)

| Participant | Benefit |
|-------------|---------|
| **Visa / Mastercard** | Their agent score becomes readable in more places → more valuable, more sticky |
| **Skyfire / Kite** | Their identity is recognized across networks they don't control |
| **ERC-8004 / on-chain** | On-chain reputation becomes usable inside off-chain/enterprise flows |
| **Indie agent devs** | One call returns every credential a subject has |
| **Marketplaces** | A unified trust badge for every seller, regardless of issuer |
| **End users** | Fewer scams, because trust signals finally compose |

Additive to all; a threat to none. That is the whole design goal.

## 4. The standard (open)

A subject (wallet / agent id / merchant host) resolves to a **signed passport**:

```jsonc
{
  "subject": "0xabc…",
  "composite": { "score": 0-100, "tier": "TRUSTED|NEUTRAL|WATCH|HIGH_RISK|UNKNOWN", "confidence": 0-1 },
  "coverage": [ { "network": "visa|skyfire|erc8004|reputation|…", "score": 0-100, "weight": 0-1.2 } ],
  "reputationNetwork": { "score": 0-100, "tier": "…", "observations": 0 },
  "passport": { /* full, HMAC-signed, verifiable */ },
  "standard": { "name": "Agent Trust Commons", "version": "0.1", "openSource": true }
}
```

Each network contributes a normalized 0–100 score (plus markers); the hub weights and combines them, **attributing every source**. The passport is signed so any verifier can confirm authenticity without trusting the transport.

### Reference implementation (live now)
- `GET  /api/trust/networks` — every network the Commons can unify
- `GET  /api/trust/resolve/:subject` — unified resolution (reputation + passport)
- `POST /api/trust/resolve` — resolution with caller-contributed network signals
- Hub UI: `/commons`

The reference resolver, reputation network, and passport code are open-source in the [x402-trust-layer repo](https://github.com/mimranchohan/x402-trust-layer).

## 5. Business model — free standard, paid convenience

The standard stays **open and self-hostable** so no one fears a new walled garden. Revenue comes from convenience, exactly like **Plaid** (banks) or **Twilio** (telcos):

1. **Hosted resolution & caching** — one fast API instead of integrating N networks.
2. **Premium SLA + analytics** — reliability guarantees and dashboards for enterprises.
3. **Integration services** — help a network plug its score into the Commons.
4. **Verified badge** — merchants/agents embed a unified, signed trust badge (small fee).

Crucially: **we never charge for the data or lock it.** We charge for making it easy. That keeps every participant comfortable joining.

## 6. Governance path (earning neutrality)

Day 1: the x402 Trust Layer runs the reference hub.
As adoption grows, governance opens to a **multi-party council** (networks, marketplaces, community) with an open spec process — so "neutral" becomes verifiable, not just claimed. A neutral utility that one company secretly controls is not neutral; the roadmap is to give that control away.

## 7. Why this is the outstanding move for us

- It turns our weakness (small, independent) into our **moat** (only the unaligned can be neutral).
- It rides every 2026 trend — fragmented silos, protocol wars, enterprises entering — without picking a side.
- We already built the core: the **reputation network** + **cross-protocol passport** + **resolver**. This reframes them from "another product" into **the standard everyone plugs into.**
- It is the rare model where the **incumbents want us to exist**, because we make their own products more valuable.

---

## Get involved
- Try the hub: **https://x402trustlayer.xyz/commons**
- Plug your network in / co-design the spec: **mimran@x402trustlayer.xyz**
- Source & spec: **https://github.com/mimranchohan/x402-trust-layer**

*Agent Trust Commons — one passport, every network. Neutral by design.*

---

## Source adapter: Solana 8004 Trustless Agent Registry (QuantuLabs)

The Commons resolver now pulls **real on-chain Solana reputation** from the [8004-solana](https://github.com/QuantuLabs/8004-solana-ts) registry (ATOM engine — trust tier, quality score, confidence, unique callers), making the unified passport genuinely multi-chain (EVM ERC-8004 + Solana 8004 + reputation network + any caller signals).

**How it works**
- When a resolved subject looks like a Solana address, the resolver calls `fetchSolana8004()` and adds a `solana8004` source to the passport (weighted 1.1).
- The adapter (`src/lib/sources/solana-8004.ts`) is **optional and lazy** — it dynamically imports `8004-solana` only when enabled. If the package or RPC is missing, it returns null and the resolver still works with every other source. It never throws.

**Enable (live Solana reads)**
```bash
npm install 8004-solana @solana/web3.js   # already in optionalDependencies
export SOLANA_8004_ENABLED=1
export SOLANA_8004_CLUSTER=mainnet-beta    # or devnet
export SOLANA_RPC_URL=https://<premium-rpc>   # Helius/QuickNode/Alchemy recommended
```
Then `GET /api/trust/resolve/<solana-asset-pubkey>` includes a `solana8004` source with the on-chain ATOM tier/score.

**Disabled by default** — no behaviour change until you set `SOLANA_8004_ENABLED=1`.

### Roadmap follow-up (write-back)
The 8004-solana SDK also supports *writing* x402 payment feedback on-chain (`giveFeedback` with `x402-resource-delivered` / `x402-good-payer` tags). A future phase can mirror the Trust Layer's own settlement/guard outcomes into the Solana 8004 registry so the two reputation systems reinforce each other (requires a funded Solana signer).

### Write-back (live): mirror Trust Layer outcomes to Solana 8004
`src/lib/sources/solana-8004-writer.ts` writes x402 feedback on-chain so the Trust Layer's own guard/settlement outcomes reinforce the Solana 8004 reputation. Optional + fire-and-forget; never breaks a paid call.

- `GET  /api/solana8004/status` — is write-back enabled?
- `POST /api/solana8004/report` (admin) — `{ agentAsset, outcome, feedbackUri? }`; outcome ∈ `resource_delivered | delivery_failed | delivery_timeout | quality_issue | good_payer | payment_failed | insufficient_funds | invalid_signature`. Maps to the matching `x402-*` tag (network `exact-svm`) and calls `giveFeedback`.

**Enable**
```bash
npm install 8004-solana @solana/web3.js
export SOLANA_8004_WRITE_ENABLED=1
export SOLANA_8004_CLUSTER=mainnet-beta
export SOLANA_RPC_URL=https://<premium-rpc>
export SOLANA_PRIVATE_KEY='[12,34,...]'   # funded Solana keypair (JSON secret-key array)
```
Disabled by default; reads (`fetchSolana8004`) work without a signer, writes need the funded keypair.
