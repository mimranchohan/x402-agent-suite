/**
 * Universal Trust Resolver — the neutral hub of the "Agent Trust Commons".
 *
 * Given any subject (wallet / agent id / merchant host), resolve a single
 * unified trust view that aggregates EVERY network's signal — Visa Agent Score,
 * Mastercard, Skyfire, Kite, ERC-8004, plus the Trust Layer's own reputation
 * network — into one signed passport. We compete with none of them; we make each
 * one's signal reachable everywhere. Switzerland of agent trust.
 *
 * The standard is open; this is the reference resolver.
 */
import { buildCrossProtocolPassport, type ProtocolSignal, type CrossProtocolPassport } from "./cross-protocol-passport.js";
import { getReputation } from "./reputation-network.js";
import { fetchSolana8004 } from "./sources/solana-8004.js";

/** Registry of trust sources the Commons can unify. Open to extension. */
export const KNOWN_NETWORKS: Record<string, { label: string; kind: string }> = {
  reputation: { label: "x402 Trust Layer Reputation Network", kind: "reputation-graph" },
  erc8004:    { label: "ERC-8004 On-chain Registry (EVM)", kind: "onchain-identity" },
  solana8004: { label: "8004 Trustless Agent Registry (Solana, ATOM)", kind: "onchain-reputation" },
  x402:       { label: "x402 (Coinbase)", kind: "payment-protocol" },
  ap2:        { label: "Google AP2 / UCP", kind: "payment-protocol" },
  mpp:        { label: "MPP", kind: "payment-protocol" },
  visa:       { label: "Visa Agent Score / Agentic Registry", kind: "network" },
  mastercard: { label: "Mastercard Agent Pay", kind: "network" },
  skyfire:    { label: "Skyfire Agent Identity", kind: "identity-credential" },
  kite:       { label: "Kite SPACE Identity", kind: "identity-credential" },
};

export type UnifiedTrust = {
  subject: string;
  resolvedAt: string;
  composite: CrossProtocolPassport["composite"];
  coverage: Array<{ network: string; label: string; kind: string; score: number; weight: number }>;
  reputationNetwork: CrossProtocolPassport["reputationNetwork"];
  sourcesCount: number;
  passport: CrossProtocolPassport; // signed, verifiable
  standard: { name: string; version: string; spec: string; openSource: boolean };
  note: string;
};

/**
 * Resolve a subject across all provided + known networks into one unified, signed view.
 * `networkSignals` lets any caller (a wallet, a marketplace, a network) contribute its
 * own score — the Commons normalizes and combines them, attributing each source.
 */
export async function resolveTrust(
  subject: string,
  networkSignals: ProtocolSignal[] = [],
  ttlSeconds = 3600,
): Promise<UnifiedTrust> {
  // Auto-pull real on-chain Solana 8004 reputation (optional; no-ops if disabled/missing).
  const signals = [...networkSignals];
  try {
    const sol = await fetchSolana8004(subject);
    if (sol) signals.push({ protocol: "solana8004", score: sol.score, markers: sol.markers });
  } catch { /* never break resolution on an optional source */ }
  const passport = await buildCrossProtocolPassport(subject, signals, ttlSeconds);
  const rep = await getReputation(subject);

  const coverage = passport.sources.map((s) => {
    const meta = KNOWN_NETWORKS[s.source] ?? { label: s.source, kind: "external" };
    return { network: s.source, label: meta.label, kind: meta.kind, score: s.score, weight: s.weight };
  });

  return {
    subject: passport.subject,
    resolvedAt: passport.issuedAt,
    composite: passport.composite,
    coverage,
    reputationNetwork: passport.reputationNetwork,
    sourcesCount: coverage.length,
    passport,
    standard: {
      name: "Agent Trust Commons",
      version: "0.1",
      spec: "https://x402trustlayer.xyz/commons",
      openSource: true,
    },
    note:
      "Neutral, multi-network trust resolution. We aggregate — we do not replace — each network's signal. " +
      (rep.observations === 0
        ? "No reputation-network history yet for this subject."
        : "Includes live Trust Layer reputation-network history."),
  };
}

/** The list of networks the Commons can unify (for the /commons page + partners). */
export function listKnownNetworks(): Array<{ id: string; label: string; kind: string }> {
  return Object.entries(KNOWN_NETWORKS).map(([id, m]) => ({ id, label: m.label, kind: m.kind }));
}
