/**
 * Pricing tiers — session bundles + value-based fee (roadmap P1 revenue).
 *
 * Pure catalog + calculator. Does NOT modify live session settlement (that stays
 * in session-routes); this exposes the bundle catalog and a value-based fee quote
 * that the pricing page and agents can use. 2026 reality: sub-$1 flows collapsed to
 * ~4%, so high-value ($1+) flows carry the value — price accordingly.
 */
export type Bundle = { id: string; label: string; priceUsdc: number; durationHours: number; maxCalls: number | null; note: string };

export const SESSION_BUNDLES: Bundle[] = [
  { id: "day", label: "Day Pass", priceUsdc: 0.1, durationHours: 24, maxCalls: null, note: "Skip per-call settlement for 24h." },
  { id: "week", label: "Week Pass", priceUsdc: 0.5, durationHours: 168, maxCalls: null, note: "7 days, best for steady fleets." },
  { id: "month", label: "Month Pass", priceUsdc: 1.5, durationHours: 720, maxCalls: null, note: "30 days, lowest effective per-day cost." },
  { id: "burst", label: "Burst 10k", priceUsdc: 2.0, durationHours: 720, maxCalls: 10000, note: "10,000 guard calls, 30-day window." },
];

export type SubscriptionTier = { id: string; label: string; monthlyUsd: number; features: string[] };

export const SUBSCRIPTION_TIERS: SubscriptionTier[] = [
  { id: "pro", label: "Pro", monthlyUsd: 49, features: ["Dashboard", "Webhooks", "Reputation history"] },
  { id: "team", label: "Team", monthlyUsd: 499, features: ["Compliance ledger", "Evidence export", "Blocklist", "Priority failover"] },
  { id: "enterprise", label: "Enterprise", monthlyUsd: 0, features: ["SLA", "White-label / on-prem", "Volume %-fee", "DPA"] },
];

export type ValueFeeQuote = { amountUsdc: number; feeUsdc: number; feePct: number; basis: string };

/**
 * Value-based guard fee for high-value flows: max($0.10, 0.5% of tx) up to a 1% ceiling
 * for very large payments. Tiny against a $50 payment, meaningful at scale.
 */
export function valueBasedFee(amountUsdc: number): ValueFeeQuote {
  const amt = Math.max(0, Number(amountUsdc) || 0);
  const pct = amt >= 100 ? 1.0 : amt >= 10 ? 0.7 : 0.5;
  const fee = Math.max(0.1, +(amt * (pct / 100)).toFixed(4));
  return {
    amountUsdc: amt,
    feeUsdc: amt === 0 ? 0 : fee,
    feePct: pct,
    basis: "max($0.10, 0.5–1% of transaction value) — priced where the money is, not the collapsing micro-band.",
  };
}
