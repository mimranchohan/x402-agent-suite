/**
 * Growth routes — Reputation Network (Idea 1), Partner Trust-as-a-Service (Idea 3),
 * and Cross-Protocol Passport (Idea 4). All additive and free/key-gated, so they
 * don't touch the paid x402 catalog or existing flows.
 */
import type { Express, Request, Response } from "express";
import { rateLimitAgentLookup } from "../lib/rate-limit.js";
import { constantTimeEqual } from "../protocol/crypto.js";
import { assessUrlSecurity } from "../lib/security.js";
import { isSafeOutboundUrl } from "../lib/ssrf.js";
import {
  getReputation,
  reputationStats,
  recordObservation,
  type ReputationSignal,
  type SubjectKind,
} from "../lib/reputation-network.js";
import {
  createPartner,
  authenticatePartner,
  recordPartnerGuard,
  getPartnerUsage,
} from "../lib/partner-registry.js";
import { buildCrossProtocolPassport, type ProtocolSignal } from "../lib/cross-protocol-passport.js";
import { resolveTrust, listKnownNetworks } from "../lib/trust-resolver.js";
import { scrubMetadata } from "../lib/pii-metadata-filter.js";
import { quoteGuarantee, buyGuarantee, claimGuarantee, poolStats } from "../lib/guarantee-pool.js";
import { buildAnchor, latestAnchor, listAnchors, recordAnchorTx } from "../lib/reputation-anchor.js";
import { SESSION_BUNDLES, SUBSCRIPTION_TIERS, valueBasedFee } from "../lib/pricing-tiers.js";

const LOOKUP_PER_HOUR = Number(process.env.RATE_LIMIT_AGENT_LOOKUP_PER_HOUR ?? "60") || 60;

function wrap(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.status(500).json({ error: "internal_error" });
    });
  };
}

function isAdmin(req: Request): boolean {
  const secret = process.env.ADMIN_SECRET?.trim();
  if (!secret) return false;
  const raw = req.headers["x-admin-secret"];
  const provided = Array.isArray(raw) ? raw[0] : raw;
  return typeof provided === "string" && constantTimeEqual(secret, provided);
}

function partnerKey(req: Request): string | undefined {
  const raw = req.headers["x-partner-key"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function hostOfSafe(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function registerGrowthRoutes(app: Express): void {
  const limited = rateLimitAgentLookup(LOOKUP_PER_HOUR);

  // ---- Idea 1: Reputation Data Network (free lookups) ----

  /** Aggregated reputation for a wallet or merchant host. */
  app.get(
    "/api/reputation/:subject",
    limited,
    wrap(async (req, res) => {
      const subject = String(req.params.subject ?? "").trim();
      if (!subject) {
        res.status(400).json({ error: "subject required (wallet address or host)" });
        return;
      }
      res.json(await getReputation(subject));
    }),
  );

  /** Network-wide stats + current high-risk list (public threat feed). */
  app.get(
    "/api/reputation",
    limited,
    wrap(async (req, res) => {
      const limit =
        typeof req.query.limit === "string" ? Math.min(100, Math.max(1, Number(req.query.limit) || 20)) : 20;
      res.json(await reputationStats(limit));
    }),
  );

  /** Partner/source reports an observation that feeds the reputation graph. */
  app.post(
    "/api/reputation/report",
    wrap(async (req, res) => {
      const partner = await authenticatePartner(partnerKey(req));
      if (!partner) {
        res.status(401).json({ error: "valid X-Partner-Key required" });
        return;
      }
      const body = (req.body ?? {}) as {
        subject?: string;
        kind?: SubjectKind;
        signal?: ReputationSignal;
      };
      if (!body.subject || !body.signal) {
        res.status(400).json({ error: "subject and signal required" });
        return;
      }
      const kind: SubjectKind = body.kind ?? (body.subject.startsWith("0x") ? "wallet" : "host");
      await recordObservation(body.subject, kind, body.signal, partner.id);
      res.status(201).json({ ok: true, recorded: { subject: body.subject, signal: body.signal } });
    }),
  );

  // ---- Idea 3: Partner Trust-as-a-Service (B2B2C rev-share) ----

  /** Admin: register a facilitator/wallet/marketplace as a partner. Returns the API key once. */
  app.post(
    "/api/partner/register",
    wrap(async (req, res) => {
      if (!isAdmin(req)) {
        res.status(403).json({ error: "X-Admin-Secret required (set ADMIN_SECRET)" });
        return;
      }
      const body = (req.body ?? {}) as { name?: string; revsharePct?: number };
      if (!body.name || body.name.trim().length < 2) {
        res.status(400).json({ error: "name required" });
        return;
      }
      const created = await createPartner(body.name.trim(), Number(body.revsharePct ?? 20));
      res.status(201).json({
        ok: true,
        partner: created,
        note: "Store apiKey securely — it is shown only once.",
      });
    }),
  );

  /** Partner: see your usage + rev-share accounting. */
  app.get(
    "/api/partner/usage",
    wrap(async (req, res) => {
      const partner = await authenticatePartner(partnerKey(req));
      if (!partner) {
        res.status(401).json({ error: "valid X-Partner-Key required" });
        return;
      }
      res.json(await getPartnerUsage(partner.id));
    }),
  );

  /** Partner-embedded guard: lightweight allow/deny that a facilitator/wallet runs
   *  inline before settling. Counts toward the partner's rev-share and feeds the
   *  reputation network. Free to the partner (billed via rev-share agreement). */
  app.post(
    "/api/partner/guard",
    wrap(async (req, res) => {
      const partner = await authenticatePartner(partnerKey(req));
      if (!partner) {
        res.status(401).json({ error: "valid X-Partner-Key required" });
        return;
      }
      const body = (req.body ?? {}) as {
        targetUrl?: string;
        walletAddress?: string;
        estimatedCostUsdc?: number;
        policy?: { perCallCapUsdc?: number; dailyCapUsdc?: number; spentTodayUsdc?: number };
      };
      if (!body.targetUrl) {
        res.status(400).json({ error: "targetUrl required" });
        return;
      }
      const reasons: string[] = [];
      const sec = assessUrlSecurity(body.targetUrl);
      if (!isSafeOutboundUrl(body.targetUrl)) reasons.push("SSRF policy: private/metadata/reserved host");
      if (sec.grade === "F" || sec.grade === "D") reasons.push(`URL security grade ${sec.grade}`);
      const est = Number(body.estimatedCostUsdc ?? 0);
      const perCap = Number(body.policy?.perCallCapUsdc ?? Infinity);
      const dayCap = Number(body.policy?.dailyCapUsdc ?? Infinity);
      const spent = Number(body.policy?.spentTodayUsdc ?? 0);
      if (est > perCap) reasons.push(`per-call cap exceeded (${est} > ${perCap})`);
      if (spent + est > dayCap) reasons.push(`daily cap exceeded (${(spent + est).toFixed(2)} > ${dayCap})`);

      const allowed = reasons.length === 0;
      await recordPartnerGuard(partner.id, !allowed);

      const host = hostOfSafe(body.targetUrl);
      if (host) await recordObservation(host, "host", allowed ? "guard_pass" : "guard_block", partner.id);
      if (body.walletAddress) {
        await recordObservation(body.walletAddress, "wallet", allowed ? "guard_pass" : "guard_block", partner.id);
      }

      res.json({
        allowed,
        securityGrade: sec.grade,
        reasons,
        partner: partner.id,
        summary: allowed ? "Payment allowed by partner guard" : `Blocked: ${reasons.join("; ")}`,
      });
    }),
  );

  // ---- Idea 4: Cross-Protocol Passport ----

  /** Build a signed passport aggregating x402 / AP2 / MPP + reputation network. */
  app.post(
    "/api/passport/cross-protocol",
    limited,
    wrap(async (req, res) => {
      const body = (req.body ?? {}) as {
        subject?: string;
        protocolSignals?: ProtocolSignal[];
        ttlSeconds?: number;
      };
      if (!body.subject) {
        res.status(400).json({ error: "subject required (wallet address or agent id)" });
        return;
      }
      const passport = await buildCrossProtocolPassport(
        body.subject,
        Array.isArray(body.protocolSignals) ? body.protocolSignals : [],
        Number(body.ttlSeconds ?? 3600),
      );
      res.json(passport);
    }),
  );

  // ---- Agent Trust Commons: universal trust resolver (neutral hub) ----

  /** List every network the Commons can unify. */
  app.get("/api/trust/networks", limited, wrap(async (_req, res) => {
    res.json({ standard: "Agent Trust Commons v0.1", networks: listKnownNetworks() });
  }));

  /** Resolve a subject across all known networks (reputation + passport). */
  app.get("/api/trust/resolve/:subject", limited, wrap(async (req, res) => {
    const subject = String(req.params.subject ?? "").trim();
    if (!subject) { res.status(400).json({ error: "subject required" }); return; }
    res.json(await resolveTrust(subject, []));
  }));

  /** Resolve with caller-contributed network signals (Visa/Skyfire/Kite/ERC-8004…). */
  app.post("/api/trust/resolve", limited, wrap(async (req, res) => {
    const body = (req.body ?? {}) as { subject?: string; networkSignals?: ProtocolSignal[]; ttlSeconds?: number };
    if (!body.subject) { res.status(400).json({ error: "subject required" }); return; }
    const signals = Array.isArray(body.networkSignals) ? body.networkSignals : [];
    res.json(await resolveTrust(body.subject, signals, Number(body.ttlSeconds ?? 3600)));
  }));

  // ---- PII-safe metadata filter (pre-execution scrub of x402 metadata) ----

  /** Scrub x402 payment metadata (resource_url/description/reason/memo) for PII & secrets before it leaves the trust boundary. */
  app.post("/api/privacy/metadata-scrub", limited, wrap(async (req, res) => {
    const body = (req.body ?? {}) as { fields?: Record<string, unknown>; metadata?: Record<string, unknown> };
    const fields = (body.fields && typeof body.fields === "object" ? body.fields : null)
      ?? (body.metadata && typeof body.metadata === "object" ? body.metadata : null)
      ?? (body as Record<string, unknown>);
    if (!fields || typeof fields !== "object") { res.status(400).json({ error: "fields object required" }); return; }
    res.json(scrubMetadata(fields as Record<string, unknown>));
  }));

  // ---- Parametric guarantee pool (early access) ----
  app.post("/api/guarantee/quote", limited, wrap(async (req, res) => {
    const b = (req.body ?? {}) as { subject?: string; amountUsdc?: number };
    if (!b.subject) { res.status(400).json({ error: "subject required" }); return; }
    res.json(await quoteGuarantee(b.subject, Number(b.amountUsdc ?? 0)));
  }));
  app.get("/api/guarantee/pool", limited, wrap(async (_req, res) => { res.json(await poolStats()); }));
  app.post("/api/guarantee/buy", wrap(async (req, res) => {
    if (!isAdmin(req)) { res.status(403).json({ error: "X-Admin-Secret required (early access)" }); return; }
    const b = (req.body ?? {}) as { subject?: string; amountUsdc?: number; ttlSeconds?: number };
    if (!b.subject) { res.status(400).json({ error: "subject required" }); return; }
    res.json(await buyGuarantee(b.subject, Number(b.amountUsdc ?? 0), Number(b.ttlSeconds ?? 86400)));
  }));
  app.post("/api/guarantee/claim", wrap(async (req, res) => {
    if (!isAdmin(req)) { res.status(403).json({ error: "X-Admin-Secret required (early access)" }); return; }
    const b = (req.body ?? {}) as { policyId?: string };
    if (!b.policyId) { res.status(400).json({ error: "policyId required" }); return; }
    res.json(await claimGuarantee(b.policyId));
  }));

  // ---- On-chain reputation anchoring ----
  app.get("/api/reputation/anchor", limited, wrap(async (_req, res) => { res.json(await latestAnchor() ?? { note: "no anchor yet" }); }));
  app.get("/api/reputation/anchors", limited, wrap(async (req, res) => {
    const lim = typeof req.query.limit === "string" ? Math.min(100, Math.max(1, Number(req.query.limit) || 20)) : 20;
    res.json({ anchors: await listAnchors(lim) });
  }));
  app.post("/api/reputation/anchor", wrap(async (req, res) => {
    if (!isAdmin(req)) { res.status(403).json({ error: "X-Admin-Secret required" }); return; }
    res.status(201).json(await buildAnchor());
  }));
  app.post("/api/reputation/anchor/tx", wrap(async (req, res) => {
    if (!isAdmin(req)) { res.status(403).json({ error: "X-Admin-Secret required" }); return; }
    const b = (req.body ?? {}) as { anchorId?: string; txHash?: string };
    if (!b.anchorId || !b.txHash) { res.status(400).json({ error: "anchorId and txHash required" }); return; }
    res.json({ ok: await recordAnchorTx(b.anchorId, b.txHash) });
  }));

  // ---- Pricing: bundles, tiers, value-based fee ----
  app.get("/api/pricing/bundles", limited, wrap(async (_req, res) => { res.json({ sessionBundles: SESSION_BUNDLES, subscriptionTiers: SUBSCRIPTION_TIERS }); }));
  app.post("/api/pricing/value-fee", limited, wrap(async (req, res) => {
    const b = (req.body ?? {}) as { amountUsdc?: number };
    res.json(valueBasedFee(Number(b.amountUsdc ?? 0)));
  }));
}
