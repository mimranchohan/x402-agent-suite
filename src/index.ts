import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import cors from "cors";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { assertConfig, config } from "./config.js";
import { db, dbPath } from "./lib/db.js";
import "./lib/db.js";
import { logger } from "./lib/logger.js";
import { startOtelIfEnabled } from "./lib/otel.js";
import { sendProblem } from "./lib/problem-detail.js";
import { telemetryMiddleware, metricsPayload } from "./lib/telemetry.js";
import { createPaidMiddleware } from "./lib/x402-paid.js";
import {
  buildDiscoverCatalog,
  buildServicesManifest,
  buildWellKnownX402,
} from "./lib/bazaar.js";
import {
  buildAgentCashOpenApi,
  buildWellKnownX402Resources,
  buildWellKnownX402V2,
} from "./lib/openapi-agentcash.js";
import { registerA2AAgentCard } from "./routes/a2a-agent-card.js";
import { renderDiscoveryPage } from "./lib/discovery-page.js";
import { applyVerifierExampleBody } from "./lib/apply-verifier-body.js";
import { replayBindingMiddleware } from "./lib/replay-middleware.js";
import { registerAgenticProbes, stripTrailingSlash } from "./lib/agentic-probes.js";
import { registerWebhookRoutes } from "./lib/webhook-routes.js";
import { registerGrowthRoutes } from "./routes/growth-routes.js";
import {
  ADVANCED_ENTRYPOINTS,
  KILLER_SELLER_ENDPOINTS,
  PRIMARY_ENTRYPOINTS,
} from "./lib/suite-catalog.js";
import { listEndpoints, registerRoutes } from "./routes.js";
import { registerX402gleHostVerification } from "./lib/x402gle-host-verify.js";
import { ensureVerifierProbeMandate } from "./lib/mandate.js";
import { ensureVerifierProbeProtocol } from "./lib/verifier-probe-protocol.js";
import { SUITE_VERSION } from "./lib/version.js";
import { refreshFacilitatorExtras, startFacilitatorExtrasRefresh } from "./lib/facilitator-extra.js";
import { rateLimitPerMinute, rateLimitUnpaidProbes, rateLimitAgentLookup } from "./lib/rate-limit.js";
import { walletBlocklistMiddleware } from "./middleware/wallet-blocklist.js";

/** Default per-IP hourly cap for free lookup endpoints. Override with RATE_LIMIT_AGENT_LOOKUP_PER_HOUR. */
const AGENT_LOOKUP_DEFAULT_PER_HOUR = 60;
const _agentLookupPerHour = parseInt(process.env.RATE_LIMIT_AGENT_LOOKUP_PER_HOUR ?? "", 10);
const AGENT_LOOKUP_PER_HOUR = Number.isFinite(_agentLookupPerHour) && _agentLookupPerHour > 0
  ? _agentLookupPerHour
  : AGENT_LOOKUP_DEFAULT_PER_HOUR;
import { handleAgentLookup } from "./agents/agent-verify.js";
import { attachPaymentIdentity } from "./lib/mpp-identity.js";
import { runCertifiedLookup, runCertifiedCatalog } from "./agents/trust-network.js";

assertConfig();

void startOtelIfEnabled();

void refreshFacilitatorExtras().catch((err) => {
  logger.warn(
    { err: err instanceof Error ? err.message : String(err) },
    "Facilitator /supported preload failed",
  );
});
startFacilitatorExtrasRefresh();

void ensureVerifierProbeMandate().catch((err) => {
  logger.warn({ err: err instanceof Error ? err.message : err }, "Verifier probe mandate seed skipped");
});

void ensureVerifierProbeProtocol().catch((err) => {
  logger.warn({ err: err instanceof Error ? err.message : err }, "Verifier probe protocol seed skipped");
});

const app = express();
app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));
app.disable("x-powered-by");
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);
const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()).filter(Boolean);
app.use(cors({ origin: corsOrigins?.length ? corsOrigins : false }));

app.use((req, res, next) => {
  res.setHeader("API-Version", "1");
  const orig = req.originalUrl;
  if (orig.startsWith("/api/v1/")) {
    req.url = `/api/${orig.slice("/api/v1/".length)}`;
  } else if (orig.startsWith("/api/")) {
    res.setHeader("X-Deprecated", "true");
  }
  next();
});

app.use(telemetryMiddleware);
registerA2AAgentCard(app);
registerX402gleHostVerification(app);
app.use(stripTrailingSlash);
app.use(express.json({ limit: "512kb" }));
/** Unpaid probes → 402 (x402scan). Paid retries capped separately. */
app.use("/api", rateLimitUnpaidProbes(Number(process.env.RATE_LIMIT_UNPAID_PER_MIN ?? 600)));
app.use("/api", rateLimitPerMinute(Number(process.env.RATE_LIMIT_PER_MIN ?? 120)));

/** Canonical example bodies for x402gle / Dexter AI verifier (empty or partial POST) */
app.use("/api", (req, _res, next) => {
  applyVerifierExampleBody(req);
  next();
});
app.use("/api", replayBindingMiddleware);
app.use("/api", walletBlocklistMiddleware());
app.use("/api", attachPaymentIdentity);

/** Trust Layer brand landing page — served to browsers at `/`; machines still get JSON. */
let LANDING_HTML = "";
try {
  LANDING_HTML = readFileSync(join(process.cwd(), "public", "index.html"), "utf8");
} catch {
  LANDING_HTML = "";
}

/** Fresh catalog for landing (avoid stale 38-route cache after deploy). */
app.get("/data/agents.json", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.sendFile(join(process.cwd(), "public", "data", "agents.json"));
});

/** Live agent-features dashboard — explorer over the full catalog + /health stats. */
app.get("/dashboard", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(join(process.cwd(), "public", "dashboard.html"));
});

/** Public status page — reads live /health. */
app.get("/status", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=30");
  res.sendFile(join(process.cwd(), "public", "status.html"));
});

/** Pricing page. */
app.get("/pricing", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(join(process.cwd(), "public", "pricing.html"));
});

/** Legal / terms / privacy page. */
app.get("/legal", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(join(process.cwd(), "public", "legal.html"));
});

/** Public Scam Radar / reputation page. */
app.get("/reputation", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=60");
  res.sendFile(join(process.cwd(), "public", "reputation.html"));
});

/** Agent Trust Commons — neutral hub landing. */
app.get("/commons", (_req, res) => {
  res.setHeader("Cache-Control", "public, max-age=300");
  res.sendFile(join(process.cwd(), "public", "commons.html"));
});

/** Static public files (landing.js, data, assets). index.html served via GET / negotiation. */
app.use(
  express.static(join(process.cwd(), "public"), {
    index: false,
    maxAge: "1h",
    setHeaders(res, filePath) {
      if (filePath.replace(/\\/g, "/").endsWith("/data/agents.json")) {
        res.setHeader("Cache-Control", "public, max-age=60");
      }
    },
  }),
);

const paid = createPaidMiddleware();

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

const GITHUB_REPO = "https://github.com/mimranchohan/x402-trust-layer";

function healthPayload() {
  const dataDir = process.env.DATA_DIR?.trim() || "/app/data";
  return {
    ok: true,
    service: "x402-trust-layer",
    version: SUITE_VERSION,
    protocol: "agent-trust-protocol-v4",
    protocolArchitecture: `${config.publicBaseUrl}/api/protocol/architecture`,
    chains: config.chains,
    networks: config.networks,
    facilitator: config.facilitatorUrl,
    facilitatorConfig: {
      timeoutMs: Number(process.env.X402_FACILITATOR_TIMEOUT_MS) || 90_000,
      maxRetries: Number(process.env.X402_FACILITATOR_MAX_RETRIES) || 2,
      paidRequestBudgetMs: Number(process.env.PAID_REQUEST_TIMEOUT_MS) || 70_000,
    },
    endpointCount: listEndpoints().length,
    nonceBackend: metricsPayload().nonceBackend,
    gitCommit: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
    deploy: {
      platform: process.env.RAILWAY_ENVIRONMENT ? "railway" : null,
      docker: true,
      volumeMount: "/app/data",
      dataDir,
      sqlitePath: dbPath(),
      entrypoint: "scripts/docker-entrypoint.sh (chown volume for non-root app user)",
    },
    documentation: {
      github: GITHUB_REPO,
      railwayDeploy: `${GITHUB_REPO}/blob/main/docs/RAILWAY-DEPLOY.md`,
      productionHardening: `${GITHUB_REPO}/blob/main/docs/PRODUCTION-HARDENING.md`,
      npm: "https://www.npmjs.com/package/x402-trust-layer",
    },
    agenticGetProbes: true,
    agenticReady:
      config.publicBaseUrl.startsWith("https://") &&
      config.chains.includes("base") &&
      config.payToEvm.length > 0,
    agenticHint: !config.payToEvm
      ? "Set PAY_TO_EVM + NETWORKS=base,solana on Railway for agentic.market"
      : config.publicBaseUrl.includes("railway.app") &&
          !process.env.PUBLIC_BASE_URL &&
          !process.env.CANONICAL_PUBLIC_URL
        ? `Set PUBLIC_BASE_URL=${config.canonicalOrigin} so discovery URLs match x402trustlayer.xyz`
        : null,
    agentCashDiscovery: {
      openapi: `${config.publicBaseUrl}/openapi.json`,
      wellKnown: `${config.publicBaseUrl}/.well-known/x402`,
      ready:
        config.publicBaseUrl.startsWith("https://") && config.payToEvm.length > 0,
    },
    primaryProducts: PRIMARY_ENTRYPOINTS,
    settlementGuidance: {
      rails: ["x402-usdc", "mpp-agent-id", "ap2-mandate"],
      facilitator: config.facilitatorUrl,
      alternatives: [
        "USE_CDP_FACILITATOR=1 with CDP API keys",
        "X402_PREFERRED_NETWORK=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp for Dexter Base outages",
        "POST /api/facilitator/failover before high-value spend",
      ],
      knownUpstreamIssue:
        "Dexter Base sponsored Permit2 may return facilitator_error_500 when tx does not confirm on-chain",
    },
  };
}

app.get("/llms.txt", (_req, res) => {
  try {
    const txt = readFileSync(join(process.cwd(), "public", "llms.txt"), "utf8");
    res.type("text/plain").send(txt);
  } catch {
    res.status(404).type("text/plain").send("llms.txt not found");
  }
});

app.get("/llms-full.txt", (_req, res) => {
  try {
    const txt = readFileSync(join(process.cwd(), "public", "llms-full.txt"), "utf8");
    res.type("text/plain").send(txt);
  } catch {
    res.status(404).type("text/plain").send("llms-full.txt not found");
  }
});

app.get("/skill.md", (_req, res) => {
  try {
    const md = readFileSync(join(process.cwd(), "public", "skill.md"), "utf8");
    res.type("text/markdown").send(md);
  } catch {
    res.status(404).type("text/plain").send("skill.md not found");
  }
});

app.get("/metrics", (_req, res) => {
  res.json(metricsPayload());
});

app.get("/robots.txt", (_req, res) => {
  res
    .type("text/plain")
    .send(
      "User-agent: *\nAllow: /\nSitemap: /sitemap.xml\n# Agent-friendly: see /llms.txt\n",
    );
});

app.get("/.well-known/x402/v2", (_req, res) => {
  res.json(buildWellKnownX402V2());
});

app.get("/health", (_req, res) => {
  let dbOk = false;
  let diskOk = false;
  try {
    db.prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    /* db down */
  }
  try {
    statSync(process.cwd());
    diskOk = true;
  } catch {
    /* disk */
  }
  const status = dbOk && diskOk ? 200 : 503;
  res.status(status).json({
    ...healthPayload(),
    ok: dbOk && diskOk,
    db: dbOk ? "ok" : "error",
    disk: diskOk ? "ok" : "error",
  });
});

// Compatibility aliases used by some external quality probes.
app.get("/api/health", (_req, res) => {
  let dbOk = false;
  let diskOk = false;
  try {
    db.prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    /* */
  }
  try {
    statSync(process.cwd());
    diskOk = true;
  } catch {
    /* */
  }
  const status = dbOk && diskOk ? 200 : 503;
  res.status(status).json({
    ...healthPayload(),
    ok: dbOk && diskOk,
    db: dbOk ? "ok" : "error",
    disk: diskOk ? "ok" : "error",
  });
});

app.get("/api/version", (_req, res) => {
  res.json({ service: "x402-agent-suite-pro", version: SUITE_VERSION });
});

app.get("/api/agents", (_req, res) => {
  res.json({
    count: listEndpoints().length,
    endpoints: listEndpoints(),
  });
});

app.get("/openapi.json", (_req, res) => {
  res.json(buildAgentCashOpenApi());
});

/** AgentCash / x402scan discovery fan-out (canonical path) */
app.get("/.well-known/x402", (_req, res) => {
  res.json(buildWellKnownX402Resources());
});

app.get("/.well-known/x402.json", (_req, res) => {
  res.json(buildWellKnownX402());
});

/** Human-friendly discovery view (landing page links here instead of raw JSON path). */
app.get("/discovery", (_req, res) => {
  res.type("html").send(renderDiscoveryPage(buildWellKnownX402Resources(), config.publicBaseUrl));
});

/** Same manifest as /.well-known/x402 — free catalog (HTTP 200). Not for agentic.market Validate. */
app.get("/discovery.json", (_req, res) => {
  res.json({
    ...buildWellKnownX402Resources(),
    agenticValidateNote:
      "Do not submit this URL to agentic.market Validate. Use paid /api/* URLs from GET /api/agentic/validate-urls instead.",
  });
});

app.get("/x402/api/services.json", (_req, res) => {
  res.json(buildServicesManifest());
});

function sendDiscoverCatalog(_req: Request, res: Response): void {
  res.json(buildDiscoverCatalog());
}

app.get("/x402/api/discover", sendDiscoverCatalog);
/** Redirects — canonical path is /x402/api/discover */
app.get("/x402/discover", (_req, res) => res.redirect(301, "/x402/api/discover"));

app.use((req, res, next) => {
  if ((req.headers.host || "").startsWith("x402trustscore."))
    return void res.redirect(301, "https://x402trustlayer.xyz" + req.originalUrl);
  next();
});
app.get("/discover", (_req, res) => res.redirect(301, "/x402/api/discover"));

app.get("/", (req, res) => {
  const acceptsHtml = (req.headers.accept ?? "").includes("text/html");
  if (acceptsHtml && LANDING_HTML) {
    res.type("html").send(LANDING_HTML);
    return;
  }
  const all = listEndpoints();
  res.json({
    name: "x402 Trust Layer — Agent Suite",
    version: SUITE_VERSION,
    description: `${all.length} paid x402 infrastructure APIs — guard, semantic escrow, mandate diff, certified seller network, Agent Trust Protocol v4`,
    github: GITHUB_REPO,
    npm: "https://www.npmjs.com/package/x402-trust-layer",
    docs: `${config.publicBaseUrl}/openapi.json`,
    llmsTxt: `${config.publicBaseUrl}/llms.txt`,
    skillMd: `${config.publicBaseUrl}/skill.md`,
    discovery: `${config.publicBaseUrl}/x402/api/discover`,
    bazaar: `${config.publicBaseUrl}/x402/api/services.json`,
    deployDocs: `${GITHUB_REPO}/blob/main/docs/RAILWAY-DEPLOY.md`,
    agenticMarket: "https://agentic.market/",
    agentCash: "https://agentcash.dev/",
    x402scanRegister: "https://www.x402scan.com/resources/register",
    dexterSeller: `https://dexter.cash/sellers/${config.payTo}`,
    pipeline: `${config.publicBaseUrl}/api/pipeline/full`,
    onboarding: {
      primary: PRIMARY_ENTRYPOINTS,
      advanced: ADVANCED_ENTRYPOINTS,
      killerSeller: KILLER_SELLER_ENDPOINTS,
      advancedCount: all.length - PRIMARY_ENTRYPOINTS.length - KILLER_SELLER_ENDPOINTS.length,
    },
    endpoints: all,
  });
});

const postHandlers = registerRoutes(app, paid, asyncRoute);
registerWebhookRoutes(app);
registerGrowthRoutes(app);

/** Free ERC-8004 lookup — rate limited per IP (default 60/hr, override RATE_LIMIT_AGENT_LOOKUP_PER_HOUR) */
app.get(
  "/api/agent/lookup/:wallet",
  rateLimitAgentLookup(AGENT_LOOKUP_PER_HOUR),
  asyncRoute(handleAgentLookup),
);

/** Free certified seller lookup — rate limited */
app.get(
  "/api/merchant-trust/certified/:host",
  rateLimitAgentLookup(AGENT_LOOKUP_PER_HOUR),
  asyncRoute(async (req, res) => {
    const host = String(req.params.host ?? "").trim();
    if (!host) {
      res.status(400).json({ error: "host required" });
      return;
    }
    res.json(await runCertifiedLookup(host));
  }),
);

app.get(
  "/api/trust-network/catalog",
  rateLimitAgentLookup(AGENT_LOOKUP_PER_HOUR),
  asyncRoute(async (req, res) => {
    const limit =
      typeof req.query.limit === "string" ? Math.min(100, Math.max(1, Number(req.query.limit) || 50)) : 50;
    res.json(await runCertifiedCatalog(limit));
  }),
);

registerAgenticProbes(app, paid, postHandlers);

/** Copy-paste URLs for Agentic Validate Endpoint (free) */
app.get("/api/agentic/validate-urls", (_req, res) => {
  const base = config.publicBaseUrl;
  res.json({
    note: "Paste these exact URLs into agentic.market Validate Endpoint. No trailing slash.",
    doNotValidate: [
      `${base}/discovery.json`,
      `${base}/.well-known/x402`,
      `${base}/health`,
      `${base}/x402/api/discover`,
    ],
    agenticGetProbes: true,
    cdpBazaarHint:
      "For CDP Bazaar auto-index, set USE_CDP_FACILITATOR=1 and FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402/facilitator with CDP API keys, then complete one settlement per route.",
    facilitator: config.facilitatorUrl,
    urls: listEndpoints().map((e) => {
      const [, path] = e.path.split(" ");
      return `${base}${path}`;
    }),
    example: `${base}/api/x402/proxy`,
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    logger.error({ err }, "API error after headers sent");
    return;
  }
  const errObj = err instanceof Error ? { message: err.message, stack: err.stack } : { details: String(err) };
  logger.error({ err: errObj }, "API error");
  const expose =
    process.env.NODE_ENV !== "production" && !process.env.RAILWAY_ENVIRONMENT;
  if (expose && err instanceof Error) {
    sendProblem(res, 500, "Internal server error", err.message);
    return;
  }
  sendProblem(res, 500, "Internal server error");
});

const host = "0.0.0.0";
const server = app.listen(config.port, host, () => {
  logger.info(
    {
      version: SUITE_VERSION,
      endpoints: listEndpoints().length,
      chains: config.chains.join(","),
      git: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "local",
      public: config.publicBaseUrl,
    },
    "x402 Trust Layer listening",
  );

  // Self-Registration Bootstrapper (Zero-Marketing Autonomous Discovery)
  const isProduction =
    config.publicBaseUrl.startsWith("https://") &&
    !config.publicBaseUrl.includes("localhost") &&
    !config.publicBaseUrl.includes("127.0.0.1");

  if (isProduction) {
    setTimeout(() => {
      logger.info({}, "Triggering autonomous registry pings (Self-Advertising)...");

      // 1. Ping x402scan
      const x402scanUrl = `https://www.x402scan.com/api/trpc/public.resources.registerFromOrigin`;
      fetch(x402scanUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { origin: config.publicBaseUrl } }),
      })
        .then(async (res) => {
          const text = await res.text();
          logger.info({ status: res.status, response: text.slice(0, 100) }, "x402scan autonomous registration ping complete");
        })
        .catch((err) => logger.error({ err: err instanceof Error ? err.message : err }, "x402scan autonomous registration ping failed"));

      // 2. Ping Agent.market
      const manifest = {
        name: "x402 Trust Layer",
        description: "Guard, Attest, Comply, Audit — paid x402 APIs for autonomous agent payment safety and agent-to-agent orchestration.",
        url: config.publicBaseUrl,
        openapi: `${config.publicBaseUrl.replace(/\/$/, "")}/openapi.json`,
        x402Discovery: `${config.publicBaseUrl.replace(/\/$/, "")}/.well-known/x402`,
        categories: ["trust", "compliance", "payments", "identity"],
        priceRange: { min: 0.02, max: 0.45, currency: "USDC" },
        networks: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "eip155:137"],
      };
      const agentMarketUrl = process.env.AGENT_MARKET_REGISTER_URL || "https://agent.market/api/register";
      fetch(agentMarketUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manifest),
      })
        .then(async (res) => {
          const text = await res.text();
          logger.info({ status: res.status, response: text.slice(0, 100) }, "Agent.market autonomous registration ping complete");
        })
        .catch((err) => logger.error({ err: err instanceof Error ? err.message : err }, "Agent.market autonomous registration ping failed"));
    }, 15000);
  }
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown initiated");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    db.close();
  } catch {
    /* ignore */
  }
  logger.info({}, "Clean shutdown complete");
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception");
  void shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection");
  void shutdown("unhandledRejection");
});
