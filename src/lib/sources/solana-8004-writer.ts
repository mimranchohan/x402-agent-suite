/**
 * Solana 8004 write-back — mirror Trust Layer outcomes into the on-chain
 * QuantuLabs 8004 registry as x402 feedback (so the two reputation systems
 * reinforce each other).
 *
 * Maps a Trust Layer outcome to an x402 feedback tag and calls
 * sdk.giveFeedback(targetAgentAsset, ...). OPTIONAL + lazy + fire-and-forget:
 * requires SOLANA_8004_WRITE_ENABLED=1 AND a funded Solana signer
 * (config.solanaPrivateKey, JSON secret-key array). If anything is missing it
 * no-ops and returns null. Never throws — write-back must never break a paid call.
 *
 * Env:
 *   SOLANA_8004_WRITE_ENABLED=1
 *   SOLANA_8004_CLUSTER=mainnet-beta (or devnet)
 *   SOLANA_RPC_URL=https://<premium-rpc>
 *   SOLANA_PRIVATE_KEY=[12,34,...]   (read once into config.solanaPrivateKey)
 */
import { config } from "../../config.js";
import { looksLikeSolanaAddress } from "./solana-8004.js";

export type X402Outcome =
  | "resource_delivered"
  | "delivery_failed"
  | "delivery_timeout"
  | "quality_issue"
  | "good_payer"
  | "payment_failed"
  | "insufficient_funds"
  | "invalid_signature";

const OUTCOME_MAP: Record<X402Outcome, { tag1: string; score: number; value: string }> = {
  resource_delivered: { tag1: "x402-resource-delivered", score: 95, value: "100.00" },
  delivery_failed:    { tag1: "x402-delivery-failed", score: 5, value: "0" },
  delivery_timeout:   { tag1: "x402-delivery-timeout", score: 10, value: "0" },
  quality_issue:      { tag1: "x402-quality-issue", score: 30, value: "0" },
  good_payer:         { tag1: "x402-good-payer", score: 100, value: "1" },
  payment_failed:     { tag1: "x402-payment-failed", score: 5, value: "0" },
  insufficient_funds: { tag1: "x402-insufficient-funds", score: 10, value: "0" },
  invalid_signature:  { tag1: "x402-invalid-signature", score: 0, value: "0" },
};

const WRITE_ENABLED = process.env.SOLANA_8004_WRITE_ENABLED === "1";

export function isSolana8004WriteEnabled(): boolean {
  return WRITE_ENABLED && !!config.solanaPrivateKey;
}

function loadSigner(KeypairCtor: any): unknown | null {
  const raw = config.solanaPrivateKey?.trim();
  if (!raw) return null;
  try {
    if (raw.startsWith("[")) {
      return KeypairCtor.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
    // Only JSON secret-key arrays are supported without a base58 dep.
    return null;
  } catch {
    return null;
  }
}

export type WriteResult = { ok: boolean; signature?: string; reason: string };

/**
 * Report an x402 outcome for a Solana 8004 agent asset. Fire-and-forget safe.
 * @param targetAgentAsset the agent's Core asset pubkey (base58)
 */
export async function reportToSolana8004(
  targetAgentAsset: string,
  outcome: X402Outcome,
  feedbackUri?: string,
): Promise<WriteResult | null> {
  if (!isSolana8004WriteEnabled()) return null;
  if (!looksLikeSolanaAddress(targetAgentAsset)) return null;
  const m = OUTCOME_MAP[outcome];
  if (!m) return null;
  try {
    // @ts-ignore — optional dependency, present only when write is enabled
    const mod: any = await import("8004-solana");
    // @ts-ignore — optional dependency
    const web3: any = await import("@solana/web3.js");
    const SolanaSDK = mod.SolanaSDK;
    const Keypair = web3.Keypair;
    if (!SolanaSDK || !Keypair) return null;
    const signer = loadSigner(Keypair);
    if (!signer) return { ok: false, reason: "signer unavailable (need JSON secret-key array)" };

    const cluster = process.env.SOLANA_8004_CLUSTER || "mainnet-beta";
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const sdk = new SolanaSDK(rpcUrl ? { signer, cluster, rpcUrl } : { signer, cluster });

    const res = await sdk.giveFeedback(targetAgentAsset, {
      value: m.value,
      tag1: m.tag1,
      tag2: "exact-svm",
      score: m.score,
      ...(feedbackUri ? { feedbackUri } : {}),
    });
    const signature = typeof res?.signature === "string" ? res.signature : undefined;
    return { ok: true, signature, reason: "feedback recorded on Solana 8004" };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "write failed" };
  }
}
