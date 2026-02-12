const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

function must(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function mustNumber(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name] ?? fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number env var: ${name}`);
  if (allowZero ? n < 0 : n <= 0) throw new Error(`Invalid number env var: ${name}`);
  return n;
}

function toBool(name, fallback = "false") {
  const raw = (process.env[name] ?? fallback).toString().toLowerCase();
  return raw === "true" || raw === "1" || raw === "yes";
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: process.env.PORT || "5000",

  MYSQL_HOST: must("MYSQL_HOST"),
  MYSQL_PORT: process.env.MYSQL_PORT || "3306",
  MYSQL_USER: must("MYSQL_USER"),
  MYSQL_PASSWORD: must("MYSQL_PASSWORD"),
  MYSQL_DATABASE: must("MYSQL_DATABASE"),

  MYSQL_MIGRATE_USER: process.env.MYSQL_MIGRATE_USER || "",
  MYSQL_MIGRATE_PASSWORD: process.env.MYSQL_MIGRATE_PASSWORD || "",

  JWT_ACCESS_SECRET: must("JWT_ACCESS_SECRET"),
  JWT_REFRESH_SECRET: must("JWT_REFRESH_SECRET"),
  JWT_ACCESS_TTL_SECONDS: mustNumber("JWT_ACCESS_TTL_SECONDS", "900"),
  JWT_REFRESH_TTL_SECONDS: mustNumber("JWT_REFRESH_TTL_SECONDS", "1209600"),

  KYC_DOC_NUMBER_SALT: must("KYC_DOC_NUMBER_SALT"),

  // Comma-separated UUIDs that should be treated as admins (used by admin gates)
  ADMIN_USER_IDS: (process.env.ADMIN_USER_IDS || "").trim(),

  // ✅ USDT-only source of truth
  WALLET_CURRENCY: (process.env.WALLET_CURRENCY || "USDT").trim().toUpperCase(),

  ML_SERVICE_URL: process.env.ML_SERVICE_URL || "http://localhost:8000",
  ML_SERVICE_API_KEY: process.env.ML_SERVICE_API_KEY || process.env.ML_SERVICE_KEY || "",
  ML_SERVICE_TIMEOUT_MS: mustNumber("ML_SERVICE_TIMEOUT_MS", process.env.ML_TIMEOUT_MS || "8000"),
  ML_SERVICE_RETRIES: mustNumber("ML_SERVICE_RETRIES", process.env.ML_RETRIES || "0", { allowZero: true }),

  ML_DEBUG_ALLOW: toBool("ML_DEBUG_ALLOW", "false"),

    // MongoDB (Week 4)
  MONGO_URI: must("MONGO_URI"),
  MONGO_DB: (process.env.MONGO_DB || "secure_blockchain").trim(),

  MONGO_MAX_POOL_SIZE: mustNumber("MONGO_MAX_POOL_SIZE", "20"),
  MONGO_MIN_POOL_SIZE: mustNumber("MONGO_MIN_POOL_SIZE", "2", { allowZero: true }),
  MONGO_SERVER_SELECTION_TIMEOUT_MS: mustNumber("MONGO_SERVER_SELECTION_TIMEOUT_MS", "8000"),
  MONGO_CONNECT_TIMEOUT_MS: mustNumber("MONGO_CONNECT_TIMEOUT_MS", "8000"),

  INTERNAL_EXECUTOR_KEY: (process.env.INTERNAL_EXECUTOR_KEY || "").trim(),

  BINANCE_API_BASE: (process.env.BINANCE_API_BASE || "https://api.binance.com").trim(),
  BINANCE_PRICE_TTL_MS: mustNumber("BINANCE_PRICE_TTL_MS", "1500"),
  KYC_DOC_ENC_KEY_BASE64: must("KYC_DOC_ENC_KEY_BASE64"),



};

module.exports = { env };
