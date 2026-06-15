/**
 * Cross-Protocol Agent Passport (Idea 4).
 *
 * One verifiable passport that aggregates an agent's trust across payment
 * protocols — x402, Google AP2, and MPP — plus the Trust Layer's own reputation
 * network. While the protocols compete, a neutral passport that works across all
 * of them becomes shared infrastructure everyone needs.
 *
 * The passport is HMAC-signed (same key as attestations) so any verifier can
 * confirm it was issued by the Trust Layer and hasn't been tampered with.
 */
import { hmacSign } from "../protocol/crypto.js";
import { getReputation } from "./reputation-network.js";

export type ProtocolSignal = {
  /** e.g. "x402", "ap2", "mpp" */
  protocol: string;
  /** 0..100 trust contribution from this protocol (caller-supplied or known) */
  score?: number;
  /** free-form markers, e.g. { erc8004Tier: "GOLD", verifiedCredential: true } */
  markers?: Record<string, unknown>;
};

export type CrossProtocolPassport = {
  subject: string;
  issuedAt: string;
  expiresAt: string;
  composite: {
    score: number; // 0..100 weighted across protocols + reputation network
    tier: "TRUSTED" | "NEUTRAL" | "WATCH" | "HIGH_RISK" | "UNKNOWN";
    confidence: number; // 0..1 — grows with number of contributing sources
  };
  sources: Array<{ source: string; score: number; weight: number }>;
  reputationNetwork: { score: number; tier: string; observations: number };
  note: string;
  signature: string;
};

function tierFor(score: number, sources: number): CrossProtocolPassport["composite"]["tier"] {
  if (sources === 0) return "UNKNOWN";
  if (score >= 75) return "TRUSTED";
  if (score >= 55) return "NEUTRAL";
  if (score >= 35) return "WATCH";
  return "HIGH_RISK";
}

/** Default per-protocol weights when the caller doesn't override. */
const PROTOCOL_WEIGHT: Record<string, number> = {
  x402: 1.0,
  ap2: 0.9,
  mpp: 0.7,
  solana8004: 1.1, // real on-chain Solana reputation (ATOM)
  reputation: 1.2, // the Trust Layer's own network is weighted highest
};

export async function buildCrossProtocolPassport(
  subject: string,
  protocolSignals: ProtocolSignal[] = [],
  ttlSeconds = 3600,
): Promise<CrossProtocolPassport> {
  const rep = await getReputation(subject);

  const sources: Array<{ source: string; score: number; weight: number }> = [];

  // Reputation network is always a source (neutral 50 if no data).
  sources.push({
    source: "reputation",
    score: rep.score,
    weight: rep.observations > 0 ? PROTOCOL_WEIGHT.reputation : 0.3,
  });

  for (const sig of protocolSignals) {
    const key = sig.protocol.toLowerCase();
    const score = typeof sig.score === "number" ? Math.max(0, Math.min(100, sig.score)) : 50;
    sources.push({ source: key, score, weight: PROTOCOL_WEIGHT[key] ?? 0.5 });
  }

  const totalWeight = sources.reduce((s, x) => s + x.weight, 0) || 1;
  const composite = Math.round(
    sources.reduce((s, x) => s + x.score * x.weight, 0) / totalWeight,
  );
  const contributing = sources.filter((s) => s.weight > 0.3).length;
  const confidence = Math.min(1, +(contributing / 4).toFixed(2));

  const now = new Date();
  const body = {
    subject: subject.toLowerCase(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
    composite: { score: composite, tier: tierFor(composite, contributing), confidence },
    sources,
    reputationNetwork: { score: rep.score, tier: rep.tier, observations: rep.observations },
    note:
      "Cross-protocol passport aggregating x402 / AP2 / MPP signals with the Trust Layer reputation network. Advisory; verify the signature before relying on it.",
  };

  const signature = hmacSign(JSON.stringify(body));
  return { ...body, signature };
}

/** Verify a passport body against its signature. */
export function verifyPassportSignature(passport: CrossProtocolPassport): boolean {
  const { signature, ...body } = passport;
  return hmacSign(JSON.stringify(body)) === signature;
}
