const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");

const pinoHttp = require("pino-http");
const { logger } = require("./config/logger");

const { requestContext } = require("./middlewares/requestContext");
const { errorHandler } = require("./middlewares/errorHandler");

const authRoutes = require("./modules/auth/auth.routes");
const kycRoutes = require("./modules/kyc/kyc.routes");
const securityRoutes = require("./modules/security/security.routes");
const mlRoutes = require("./modules/ml/ml.routes");
const walletRoutes = require("./modules/wallet/wallet.routes");
const ledgerRoutes = require("./modules/ledger/ledger.routes");
const tradeRoutes = require("./modules/trade/trade.routes");
const alertsRoutes = require("./modules/alerts/alerts.routes");
const tradeInternalRoutes = require("./modules/trade/trade.internal.routes");






const { pool } = require("./config/mysql");
const { getMongoDb } = require("./config/mongo");

function parseCorsAllowlist() {
  const raw = (process.env.CORS_ORIGINS || process.env.CORS_ORIGIN || "").trim();
  if (!raw) return null;

  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return origins.length ? origins : null;
}

function corsOptionsFactory() {
  const allowlist = parseCorsAllowlist();

  // Backward-compatible: if no allowlist is provided, behave like your current config (allow all origins)
  if (!allowlist) {
    return { origin: true, credentials: true };
  }

  const allow = new Set(allowlist);

  return {
    origin(origin, cb) {
      // Allow non-browser requests (curl/postman) with no Origin header
      if (!origin) return cb(null, true);
      if (allow.has(origin)) return cb(null, true);
      return cb(new Error("CORS: origin not allowed"), false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-device-id", "x-health-key"],
    maxAge: 600,
  };
}

const app = express();

// Hardening
app.disable("x-powered-by");
if (String(process.env.TRUST_PROXY || "").toLowerCase() === "true") {
  // If behind a reverse proxy/load balancer, this makes req.ip and rate limiting accurate
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(cors(corsOptionsFactory()));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(requestContext);

app.get("/health/deep", async (req, res, next) => {
  try {
    // Optional protection (industrial default): set HEALTH_KEY to require a secret for deep checks
    const healthKey = (process.env.HEALTH_KEY || "").trim();
    if (healthKey) {
      const provided = String(req.headers["x-health-key"] || "").trim();
      if (!provided || provided !== healthKey) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
      }
    }

    await pool.query("SELECT 1");
    await getMongoDb().command({ ping: 1 });

    res.json({ ok: true, mysql: "ok", mongo: "ok" });
  } catch (e) {
    next(e);
  }
});

// log every request + status code + response time
app.use(
  pinoHttp({
    logger,

    // Ensure the canonical request id is the same everywhere
    genReqId: (req) => req.ctx?.requestId,

    customProps: (req, res) => ({
      statusCode: res.statusCode,
      requestId: req.ctx?.requestId,
      ip: req.ctx?.ip,
      deviceId: req.ctx?.deviceId,
    }),

    customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} -> ${res.statusCode} (${err?.message})`,

    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return "error";
      if (res.statusCode >= 400) return "warn";
      return "info";
    },

    autoLogging: {
      ignore: (req) => req.url === "/health" || req.url === "/health/deep",
    },
  })
);

// rate limit AFTER logging so even 429 responses are logged
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.get("/health", (_req, res) => res.json({ ok: true }));

// routes
app.use("/api/auth", authRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/security", securityRoutes);
app.use("/api/ml", mlRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/ledger", ledgerRoutes);
app.use("/api/trade", tradeRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/internal/trade", tradeInternalRoutes);
app.use("/api/ml/admin", require("./modules/ml/ml.admin.routes"));





// error handler
app.use(errorHandler);

module.exports = { app };
