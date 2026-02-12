// server/src/modules/signals/signals.service.js
const crypto = require("crypto");
const { getMongoDb } = require("../../config/mongo");
const { logger } = require("../../config/logger");

function clamp100(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  if (n <= 1) return Math.max(0, Math.min(100, Math.round(n * 100)));
  return Math.max(0, Math.min(100, Math.round(n)));
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

/**
 * Non-blocking writer (safe in auth flows): logs on failure, never throws by default.
 */
async function writeSecuritySignal({
  userId,
  createdAt = new Date(),
  risk, // 0..100
  action = "ALLOW",
  ruleRisk = null,
  mlRisk = null,
  ruleVersion = null,
  mlVersion = null,
  factors = [],
  sessionId = null,
  ctx = null,
}) {
  try {
    const db = getMongoDb();
    const doc = {
      userId,
      createdAt: new Date(createdAt),
      signalType: "SESSION_RISK",
      risk: clamp100(risk),
      action: String(action || "ALLOW").toUpperCase(),
      ruleRisk: ruleRisk == null ? null : clamp100(ruleRisk),
      mlRisk: mlRisk == null ? null : clamp100(mlRisk),
      ruleVersion,
      mlVersion,
      factors: Array.isArray(factors) ? factors : [],
      sessionId,
      ctx,
    };

    const res = await db.collection("signals_security").insertOne(doc);
    return { ok: true, insertedId: String(res.insertedId) };
  } catch (e) {
    logger.error({ err: String(e?.message || e), userId }, "signals_security_insert_failed");
    return { ok: false };
  }
}

async function writeMlSignal({
  userId,
  createdAt = new Date(),
  predictionId = uuid(),
  requestId = uuid(),
  model = null,
  horizon = null,
  interval = null,
  items = [],
}) {
  try {
    const db = getMongoDb();

    const normItems = (Array.isArray(items) ? items : []).map((it) => ({
      symbol: String(it?.symbol || "UNKNOWN").toUpperCase(),
      direction: String(it?.direction || "NEUTRAL").toUpperCase(),
      severityScore100: clamp100(it?.severityScore100 ?? it?.confidence),
      confidence: it?.confidence ?? null,
      pUp: it?.pUp ?? null,
      expReturn: it?.expReturn ?? null,
    }));

    const doc = {
      userId,
      createdAt: new Date(createdAt),
      signalType: "PRICE_PREDICTION",
      predictionId,
      requestId,
      model,
      horizon,
      interval,
      items: normItems,
    };

    const res = await db.collection("signals_ml").insertOne(doc);
    return { ok: true, insertedId: String(res.insertedId) };
  } catch (e) {
    logger.error({ err: String(e?.message || e), userId }, "signals_ml_insert_failed");
    return { ok: false };
  }
}

module.exports = {
  writeSecuritySignal,
  writeMlSignal,
};
