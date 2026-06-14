/**
 * Parametric Payment Guarantee Pool (roadmap P1 — the monetization apex).
 *
 * Crypto-native answer to Visa/Mastercard "settlement guarantee": a buyer or
 * marketplace pays a small premium to guarantee a high-value agent payment.
 * Premiums are priced from the reputation network (low risk = cheap, high risk =
 * expensive or declined). If the guarded payment goes bad (subject later flagged
 * HIGH_RISK), a parametric claim pays out from the pool — no claims adjuster.
 *
 * IMPORTANT: this is a *parametric guarantee pool*, NOT licensed insurance.
 * Start on testnet / small caps. Pure JSON-ledger accounting (same safe pattern
 * as escrow-ledger); real on-chain custody/staking is a later phase.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getReputation } from "./reputation-network.js";
import { hmacSign } from "../protocol/crypto.js";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE = path.join(DATA_DIR, "guarantee-pool.json");

const MIN_PREMIUM_USDC = 0.1;
const MAX_COVER_USDC = 500; // per-policy cap while in early access

type Policy = {
  id: string;
  subject: string;
  amountUsdc: number;
  premiumUsdc: number;
  status: "active" | "claimed" | "expired";
  createdAt: string;
  expiresAt: string;
};

type Pool = { premiumsCollectedUsdc: number; payoutsUsdc: number; policies: Record<string, Policy> };

async function read(): Promise<Pool> {
  await mkdir(DATA_DIR, { recursive: true });
  try { return JSON.parse(await readFile(FILE, "utf8")) as Pool; }
  catch { return { premiumsCollectedUsdc: 0, payoutsUsdc: 0, policies: {} }; }
}
async function write(p: Pool): Promise<void> { await writeFile(FILE, JSON.stringify(p, null, 2), "utf8"); }

export type Quote = {
  subject: string;
  amountUsdc: number;
  insurable: boolean;
  premiumUsdc: number;
  premiumPct: number;
  reputationScore: number;
  reputationTier: string;
  reason: string;
};

/** Price a guarantee from the subject's reputation. Higher risk → higher premium / decline. */
export async function quoteGuarantee(subject: string, amountUsdc: number): Promise<Quote> {
  const amt = Math.max(0, Math.min(MAX_COVER_USDC, Number(amountUsdc) || 0));
  const rep = await getReputation(subject);
  // Base rate 0.5%, scaled by risk: score 100 → 0.4%, score 0 → 6%+. Decline HIGH_RISK.
  const riskFactor = (100 - rep.score) / 100; // 0 (safe) .. 1 (risky)
  const pct = 0.4 + riskFactor * 5.6; // 0.4% .. 6.0%
  const insurable = rep.tier !== "HIGH_RISK" && amt > 0 && amt <= MAX_COVER_USDC;
  const premium = insurable ? Math.max(MIN_PREMIUM_USDC, +(amt * (pct / 100)).toFixed(4)) : 0;
  return {
    subject: rep.subject,
    amountUsdc: amt,
    insurable,
    premiumUsdc: premium,
    premiumPct: +pct.toFixed(2),
    reputationScore: rep.score,
    reputationTier: rep.tier,
    reason: insurable
      ? "Quote priced from reputation; pay the premium to activate cover."
      : rep.tier === "HIGH_RISK"
        ? "Declined: subject is HIGH_RISK on the reputation network."
        : `Amount must be > 0 and ≤ $${MAX_COVER_USDC} during early access.`,
  };
}

export type PolicyReceipt = { policy: Policy; signature: string };

/** Activate cover after a premium is received (premium settlement handled by caller / x402). */
export async function buyGuarantee(subject: string, amountUsdc: number, ttlSeconds = 86400): Promise<PolicyReceipt | { error: string }> {
  const q = await quoteGuarantee(subject, amountUsdc);
  if (!q.insurable) return { error: q.reason };
  const pool = await read();
  const now = new Date();
  const policy: Policy = {
    id: "pol_" + randomUUID().slice(0, 12),
    subject: q.subject,
    amountUsdc: q.amountUsdc,
    premiumUsdc: q.premiumUsdc,
    status: "active",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
  };
  pool.policies[policy.id] = policy;
  pool.premiumsCollectedUsdc = +(pool.premiumsCollectedUsdc + policy.premiumUsdc).toFixed(4);
  await write(pool);
  return { policy, signature: hmacSign(JSON.stringify(policy)) };
}

/** Parametric claim: pays out if the policy is active, unexpired, and the subject is now HIGH_RISK. */
export async function claimGuarantee(policyId: string): Promise<{ paid: boolean; payoutUsdc: number; reason: string }> {
  const pool = await read();
  const policy = pool.policies[policyId];
  if (!policy) return { paid: false, payoutUsdc: 0, reason: "policy not found" };
  if (policy.status !== "active") return { paid: false, payoutUsdc: 0, reason: `policy ${policy.status}` };
  if (new Date(policy.expiresAt).getTime() < Date.now()) {
    policy.status = "expired"; await write(pool);
    return { paid: false, payoutUsdc: 0, reason: "policy expired" };
  }
  const rep = await getReputation(policy.subject);
  if (rep.tier !== "HIGH_RISK") {
    return { paid: false, payoutUsdc: 0, reason: "parametric trigger not met (subject not HIGH_RISK)" };
  }
  // Trigger met — pay out (capped by available pool balance).
  const available = +(pool.premiumsCollectedUsdc - pool.payoutsUsdc).toFixed(4);
  const payout = Math.min(policy.amountUsdc, Math.max(0, available));
  policy.status = "claimed";
  pool.payoutsUsdc = +(pool.payoutsUsdc + payout).toFixed(4);
  await write(pool);
  return { paid: payout > 0, payoutUsdc: payout, reason: payout > 0 ? "parametric trigger met — payout approved" : "trigger met but pool underfunded" };
}

export async function poolStats(): Promise<Record<string, unknown>> {
  const pool = await read();
  const policies = Object.values(pool.policies);
  const active = policies.filter((p) => p.status === "active").length;
  const tvl = +(pool.premiumsCollectedUsdc - pool.payoutsUsdc).toFixed(4);
  return {
    premiumsCollectedUsdc: pool.premiumsCollectedUsdc,
    payoutsUsdc: pool.payoutsUsdc,
    poolBalanceUsdc: tvl,
    activePolicies: active,
    totalPolicies: policies.length,
    lossRatio: pool.premiumsCollectedUsdc > 0 ? +(pool.payoutsUsdc / pool.premiumsCollectedUsdc).toFixed(3) : 0,
    note: "Parametric guarantee pool (early access, small caps). Not licensed insurance.",
  };
}
