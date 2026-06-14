/**
 * PII-Safe Metadata Filter (P0 differentiator).
 *
 * Every x402 payment embeds metadata — resource_url, description, reason, memo —
 * that travels in plaintext to the payment server and facilitator BEFORE on-chain
 * settlement, and the protocol does not sanitize it. (See "Hardening x402: PII-Safe
 * Agentic Payments via Pre-Execution Metadata Filtering", arXiv 2604.11430, 2026.)
 *
 * This module scans those fields for leaked secrets and PII, returns a redacted
 * copy plus structured findings and a privacy grade, so an agent/facilitator can
 * scrub or block BEFORE the metadata leaves the trust boundary. Almost no
 * competitor ships this — it is novel and defensible.
 *
 * Pure + dependency-free. No data is stored; scrubbing happens in-memory.
 */

export type PiiKind =
  | "email"
  | "phone"
  | "credit_card"
  | "ssn"
  | "ip_address"
  | "evm_private_key"
  | "solana_private_key"
  | "seed_phrase"
  | "api_key"
  | "jwt"
  | "url_credentials";

export type PiiFinding = {
  field: string;
  kind: PiiKind;
  severity: "critical" | "high" | "medium" | "low";
  redactedSample: string; // a masked hint, never the raw secret
};

export type PiiGrade = "A" | "B" | "C" | "D" | "F";

export type MetadataScrubResult = {
  clean: boolean;
  privacyGrade: PiiGrade;
  riskScore: number; // 0..100 (higher = worse)
  findings: PiiFinding[];
  scrubbed: Record<string, string>;
  recommendation: string;
};

const SEVERITY_WEIGHT: Record<PiiFinding["severity"], number> = {
  critical: 40,
  high: 18,
  medium: 8,
  low: 3,
};

/** Detectors: [kind, severity, regex, redact-mask]. Order matters (secrets first). */
const DETECTORS: Array<{ kind: PiiKind; severity: PiiFinding["severity"]; re: RegExp }> = [
  // Secrets — critical
  { kind: "evm_private_key", severity: "critical", re: /\b0x[a-fA-F0-9]{64}\b/g },
  { kind: "seed_phrase", severity: "critical", re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/g },
  { kind: "api_key", severity: "critical", re: /\b(?:sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g },
  { kind: "jwt", severity: "high", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: "solana_private_key", severity: "critical", re: /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g },
  { kind: "url_credentials", severity: "high", re: /\bhttps?:\/\/[^\s/@]+:[^\s/@]+@/g },
  // PII — high/medium
  { kind: "credit_card", severity: "high", re: /\b(?:\d[ -]?){13,19}\b/g },
  { kind: "ssn", severity: "high", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { kind: "email", severity: "medium", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { kind: "phone", severity: "medium", re: /\b(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?){2,4}\d{2,4}\b/g },
  { kind: "ip_address", severity: "low", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
];

function luhnValid(num: string): boolean {
  const digits = num.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 6) return "***";
  return v.slice(0, 3) + "…" + v.slice(-2);
}

function redactField(field: string, value: string, findings: PiiFinding[]): string {
  let out = value;
  for (const det of DETECTORS) {
    out = out.replace(det.re, (m) => {
      // Reduce false positives for card numbers via Luhn.
      if (det.kind === "credit_card" && !luhnValid(m)) return m;
      // ip_address false-positive guard: skip if it looks like a version (e.g. 1.2.3)
      if (det.kind === "ip_address") {
        const parts = m.split(".").map(Number);
        if (parts.some((p) => p > 255)) return m;
      }
      findings.push({ field, kind: det.kind, severity: det.severity, redactedSample: mask(m) });
      return "[REDACTED:" + det.kind + "]";
    });
  }
  return out;
}

function gradeFor(score: number, hasCritical: boolean): PiiGrade {
  if (hasCritical) return "F";
  if (score >= 40) return "F";
  if (score >= 25) return "D";
  if (score >= 12) return "C";
  if (score >= 4) return "B";
  return "A";
}

/**
 * Scan and redact x402 metadata fields. Pass any string fields (resource_url,
 * description, reason, memo, etc.). Returns redacted copies + findings + grade.
 */
export function scrubMetadata(fields: Record<string, unknown>): MetadataScrubResult {
  const findings: PiiFinding[] = [];
  const scrubbed: Record<string, string> = {};

  for (const [field, raw] of Object.entries(fields ?? {})) {
    const value = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
    scrubbed[field] = redactField(field, value, findings);
  }

  // Deduplicate identical findings (same field+kind+sample).
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const k = `${f.field}|${f.kind}|${f.redactedSample}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const riskScore = Math.min(
    100,
    unique.reduce((s, f) => s + SEVERITY_WEIGHT[f.severity], 0),
  );
  const hasCritical = unique.some((f) => f.severity === "critical");
  const grade = gradeFor(riskScore, hasCritical);

  return {
    clean: unique.length === 0,
    privacyGrade: grade,
    riskScore,
    findings: unique,
    scrubbed,
    recommendation:
      unique.length === 0
        ? "No PII or secrets detected in metadata — safe to transmit."
        : hasCritical
          ? "CRITICAL: secrets detected (key/seed/api). Do NOT transmit — use the scrubbed copy and rotate any exposed secret."
          : "PII detected in plaintext metadata. Transmit the scrubbed copy, not the original, before settlement.",
  };
}
