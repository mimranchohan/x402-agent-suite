/**
 * Solana 8004 Trustless Agent Registry adapter (Agent Trust Commons source).
 *
 * Pulls REAL on-chain reputation (ATOM trust tier + quality score) from the
 * QuantuLabs 8004-solana registry and normalizes it into a 0–100 score the
 * cross-protocol passport / resolver can compose. This turns the Commons from
 * "EVM ERC-8004 only" into genuinely multi-chain trust.
 *
 * OPTIONAL + lazy: the `8004-solana` package is an optional dependency loaded only
 * when `SOLANA_8004_ENABLED=1`. If the package or RPC is missing, this no-ops and
 * returns null so the resolver still works with every other source. Never throws.
 *
 * Env:
 *   SOLANA_8004_ENABLED=1            enable this source
 *   SOLANA_8004_CLUSTER=mainnet-beta (or devnet)
 *   SOLANA_RPC_URL=https://...       premium RPC recommended for reads
 */

export type Solana8004Result = {
  score: number; // 0..100 normalized
  tier: string; // Unrated|Bronze|Silver|Gold|Platinum
  markers: Record<string, unknown>;
};

const ENABLED = process.env.SOLANA_8004_ENABLED === "1";

/** Base58 Solana pubkey heuristic (not 0x EVM, 32–44 base58 chars). */
export function looksLikeSolanaAddress(s: string): boolean {
  const v = (s || "").trim();
  if (v.startsWith("0x")) return false;
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);
}

const TIER_NAME = ["Unrated", "Bronze", "Silver", "Gold", "Platinum"];
const TIER_BASE_SCORE = [50, 60, 70, 85, 95]; // fallback when no quality score

/**
 * Fetch normalized Solana 8004 reputation for an agent asset pubkey.
 * Returns null when disabled, not a Solana address, package/RPC missing, or no data.
 */
export async function fetchSolana8004(subject: string): Promise<Solana8004Result | null> {
  if (!ENABLED) return null;
  if (!looksLikeSolanaAddress(subject)) return null;
  try {
    // @ts-ignore — optional dependency, only present when SOLANA_8004_ENABLED=1
    const mod: any = await import("8004-solana");
    const SolanaSDK = mod.SolanaSDK;
    if (!SolanaSDK) return null;
    const cluster = process.env.SOLANA_8004_CLUSTER || "mainnet-beta";
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const sdk = new SolanaSDK(rpcUrl ? { cluster, rpcUrl } : { cluster });

    // Prefer the enriched summary (quality + tier); fall back to trust tier only.
    let score: number | null = null;
    let tierNum = 0;
    const markers: Record<string, unknown> = { source: "solana-8004", cluster };

    try {
      const enriched = await sdk.getEnrichedSummary(subject);
      if (enriched) {
        tierNum = Number(enriched.trustTier ?? 0);
        if (typeof enriched.qualityScore === "number") score = Math.round(enriched.qualityScore / 100);
        markers.confidence = enriched.confidence;
        markers.riskScore = enriched.riskScore;
        markers.uniqueCallers = enriched.uniqueCallers;
        markers.totalFeedbacks = enriched.totalFeedbacks;
      }
    } catch { /* fall through to tier-only */ }

    if (score === null) {
      try {
        tierNum = Number(await sdk.getTrustTier(subject)) || 0;
      } catch { return null; }
      score = TIER_BASE_SCORE[Math.max(0, Math.min(4, tierNum))] ?? 50;
    }

    const tier = TIER_NAME[Math.max(0, Math.min(4, tierNum))] ?? "Unrated";
    markers.trustTier = tier;
    return { score: Math.max(0, Math.min(100, score)), tier, markers };
  } catch {
    return null; // package missing / RPC error / anything — never break the resolver
  }
}

export function isSolana8004Enabled(): boolean {
  return ENABLED;
}
