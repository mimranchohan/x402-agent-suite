# Growth Features — Reputation Network, Partner TaaS, Cross-Protocol Passport

Three strategic features that turn the Trust Layer from "a trust API" into defensible infrastructure. All additive, free/key-gated, and independent of the paid x402 catalog.

---

## Idea 1 — Reputation Data Network (the "Experian / Chainalysis of agents")

Every guard / KYM / fraud observation feeds a reputation graph keyed by wallet or merchant host. The more the network is used, the better the data — and **data is the moat code can't copy**.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /api/reputation/:subject` | free (rate-limited) | Aggregated score + tier for a wallet/host |
| `GET /api/reputation?limit=20` | free (rate-limited) | Network stats + live high-risk list (public threat feed) |
| `POST /api/reputation/report` | `X-Partner-Key` | A source reports an observation that feeds the graph |

Score: 0–100 (50 = neutral/no data). Tiers: TRUSTED / NEUTRAL / WATCH / HIGH_RISK / UNKNOWN.
Storage: `data/reputation-network.json`.

```bash
curl https://x402trustlayer.xyz/api/reputation/0xabc...        # lookup
curl https://x402trustlayer.xyz/api/reputation?limit=10        # threat feed
```

Report a signal (partner key required):
```bash
curl -X POST https://x402trustlayer.xyz/api/reputation/report \
  -H "X-Partner-Key: tlk_..." -H "content-type: application/json" \
  -d '{"subject":"scam.tk","kind":"host","signal":"kym_avoid"}'
```
Valid signals: `guard_pass guard_block kym_pay kym_caution kym_avoid fraud_clean fraud_flag settlement_ok settlement_fail delivery_good delivery_bad`.

---

## Idea 2/3 — Partner Trust-as-a-Service (B2B2C rev-share)

A facilitator, wallet, or marketplace embeds your guard in its own flow. Every guarded payment is counted per partner for revenue-share. **One partner deal routes thousands of agents.**

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/partner/register` | `X-Admin-Secret` | Create a partner, returns API key once |
| `POST /api/partner/guard` | `X-Partner-Key` | Lightweight allow/deny the partner runs inline; counts toward rev-share; feeds reputation |
| `GET /api/partner/usage` | `X-Partner-Key` | Partner's usage + rev-share accounting |

API keys are random (`tlk_...`); only a SHA-256 hash is stored. Default rev-share: partner keeps 20% of the notional $0.05/guard fee.

Register a partner (admin):
```bash
curl -X POST https://x402trustlayer.xyz/api/partner/register \
  -H "X-Admin-Secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"name":"Dexter Facilitator","revsharePct":25}'
```

Partner-embedded guard:
```bash
curl -X POST https://x402trustlayer.xyz/api/partner/guard \
  -H "X-Partner-Key: tlk_..." -H "content-type: application/json" \
  -d '{"targetUrl":"https://api.example.com/x","estimatedCostUsdc":0.05,"policy":{"perCallCapUsdc":1,"dailyCapUsdc":10}}'
```

---

## Idea 4 — Cross-Protocol Agent Passport

One HMAC-signed passport that aggregates an agent's trust across **x402 + AP2 + MPP + the reputation network**. A neutral passport that works across competing protocols becomes shared infrastructure.

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/passport/cross-protocol` | free (rate-limited) | Build a signed composite passport |

```bash
curl -X POST https://x402trustlayer.xyz/api/passport/cross-protocol \
  -H "content-type: application/json" \
  -d '{"subject":"0xabc...","protocolSignals":[{"protocol":"x402","score":80,"markers":{"erc8004Tier":"GOLD"}},{"protocol":"ap2","score":70}]}'
```
Returns: composite score+tier+confidence, per-source breakdown, reputation-network score, and an HMAC `signature` any verifier can check.

---

## Config / env

- `ADMIN_SECRET` — required to register partners.
- `RATE_LIMIT_AGENT_LOOKUP_PER_HOUR` — caps free lookups (default 60/hr per IP).
- Reputation + partner data persist under `data/` (the Railway volume).

## Roadmap from here
- Wire `recordObservation()` into the existing guard / KYM / fraud handlers so the graph fills automatically from real paid traffic.
- Publish top reputation scores on-chain (ERC-8004) as a public good + premium write access.
- Add a public `/reputation` HTML page (threat-feed dashboard) for marketing.

---

## Phase 2 additions (June 2026)

### PII-Safe Metadata Filter (novel — from arXiv 2604.11430)
Scrubs x402 metadata (resource_url/description/reason/memo) for PII & secrets before settlement.
- `POST /api/privacy/metadata-scrub` — body `{ "fields": {...} }` → `{ scrubbed, findings, privacyGrade A–F, riskScore, recommendation }`. Detects private keys, seed phrases, API keys, JWT, cards (Luhn), SSN, email, phone, IP. Free, rate-limited.

### Parametric Guarantee Pool (early access — counters Visa/MC "settlement guarantee")
Reputation-priced cover for high-value payments. Parametric payout if subject later flags HIGH_RISK. **Not licensed insurance; small caps.**
- `POST /api/guarantee/quote` — `{ subject, amountUsdc }` → premium priced from reputation (free).
- `GET  /api/guarantee/pool` — pool balance, loss ratio, active policies (free).
- `POST /api/guarantee/buy` — activate cover (admin / early access).
- `POST /api/guarantee/claim` — `{ policyId }` parametric claim (admin / early access).

### On-chain Reputation Anchoring (counters ACHIVX portability with verifiability)
Merkle root over the reputation snapshot, signed; publish the root on Base to make scores verifiable.
- `GET  /api/reputation/anchor` — latest signed root (free).
- `GET  /api/reputation/anchors?limit=` — history (free).
- `POST /api/reputation/anchor` — build a new anchor (admin).
- `POST /api/reputation/anchor/tx` — record the on-chain tx after publishing (admin).

### Pricing: bundles, tiers, value-based fee
- `GET  /api/pricing/bundles` — session day/week/month/burst passes + subscription tiers (free).
- `POST /api/pricing/value-fee` — `{ amountUsdc }` → `max($0.10, 0.5–1% of tx)` quote for high-value flows (free).

### Config
- `ADMIN_SECRET` gates guarantee buy/claim and anchor build/tx.
- Guarantee pool + anchors persist under `data/` (move to Postgres for scale — see ARCHITECT-AUDIT).
