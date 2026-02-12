// server/src/modules/alerts/alerts.service.js
const { ObjectId } = require("mongodb");
const { getMongoDb } = require("../../config/mongo");
const { logger } = require("../../config/logger");

function clamp100(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  // Support 0..1 or 0..100
  if (n <= 1) return Math.max(0, Math.min(100, Math.round(n * 100)));
  return Math.max(0, Math.min(100, Math.round(n)));
}

function hourBucketUtc(d = new Date()) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}`; // hourly bucket
}

function normalizeStatus(s) {
  const v = String(s || "").toUpperCase();
  if (v === "ACK" || v === "ACKED") return "ACK";
  if (v === "CLOSED") return "CLOSED";
  return "OPEN";
}

/**
 * Compute alert candidates from signals.
 * Deterministic + explainable.
 */
function buildCandidates({ secSignals, mlSignals, thresholds }) {
  const {
    minSecurityRiskToAlert = 10, // ignore noise
    minMlSeverityToAlert = 60, // alert when confidence is meaningful
  } = thresholds || {};

  const candidates = [];

  // ----------------------------
  // Security: SESSION_RISK
  // ----------------------------
  for (const s of secSignals) {
    if (String(s?.signalType || "") !== "SESSION_RISK") continue;

    const risk = clamp100(s?.risk);
    const action = String(s?.action || "ALLOW").toUpperCase();

    // Create alerts when risk is non-trivial OR action is not ALLOW
    if (risk < minSecurityRiskToAlert && action === "ALLOW") continue;

    const dedupeKey = `SEC:SESSION_RISK:${action}`;
    const score = Math.max(risk, action === "ALLOW" ? 0 : 70); // enforce higher urgency if action escalates

    candidates.push({
      userId: s.userId,
      bucket: hourBucketUtc(s.createdAt ? new Date(s.createdAt) : new Date()),
      dedupeKey,
      type: "SECURITY",
      title: `Session risk: ${action}`,
      score,
      status: "OPEN",
      sources: [
        {
          source: "signals_security",
          id: s._id,
          createdAt: s.createdAt,
        },
      ],
      explain: {
        kind: "SESSION_RISK",
        risk,
        action,
        ruleRisk: s?.ruleRisk ?? null,
        mlRisk: s?.mlRisk ?? null,
        ruleVersion: s?.ruleVersion ?? null,
        mlVersion: s?.mlVersion ?? null,
        factors: Array.isArray(s?.factors) ? s.factors : [],
      },
      meta: {
        sessionId: s?.sessionId ?? null,
        ctx: s?.ctx ?? null,
      },
    });
  }

  // ----------------------------
  // ML: PRICE_PREDICTION items
  // ----------------------------
  for (const s of mlSignals) {
    if (String(s?.signalType || "") !== "PRICE_PREDICTION") continue;

    const items = Array.isArray(s?.items) ? s.items : [];
    for (const it of items) {
      const sev = clamp100(it?.severityScore100 ?? it?.confidence);
      if (sev < minMlSeverityToAlert) continue;

      const symbol = String(it?.symbol || "UNKNOWN").toUpperCase();
      const direction = String(it?.direction || "NEUTRAL").toUpperCase();

      // Dedupe by (symbol + direction) per hour
      const dedupeKey = `ML:PRICE_PREDICTION:${symbol}:${direction}`;

      candidates.push({
        userId: s.userId,
        bucket: hourBucketUtc(s.createdAt ? new Date(s.createdAt) : new Date()),
        dedupeKey,
        type: "ML",
        title: `Price signal: ${symbol} ${direction}`,
        score: sev,
        status: "OPEN",
        sources: [
          {
            source: "signals_ml",
            id: s._id,
            createdAt: s.createdAt,
            predictionId: s?.predictionId ?? null,
            requestId: s?.requestId ?? null,
          },
        ],
        explain: {
          kind: "PRICE_PREDICTION",
          symbol,
          direction,
          severityScore100: sev,
          confidence: it?.confidence ?? null,
          pUp: it?.pUp ?? null,
          expReturn: it?.expReturn ?? null,
          model: s?.model ?? null,
          horizon: s?.horizon ?? null,
          interval: s?.interval ?? null,
        },
        meta: {
          predictionId: s?.predictionId ?? null,
          requestId: s?.requestId ?? null,
        },
      });
    }
  }

  return candidates;
}

/**
 * Option B implementation:
 * - Use a pipeline update so we can:
 *   1) keep score monotonic via max(old, incoming)
 *   2) update explain/meta ONLY when incoming score > old score
 *   3) union sources arrays without duplicates
 */
function buildUpsertPipeline({ now, candidate }) {
  const incomingScore = clamp100(candidate.score);

  // Note: pipeline uses "old" values of $score/$explain/$meta in expressions
  // (within the same stage), which is exactly what we want.
  return [
    {
      $set: {
        userId: { $ifNull: ["$userId", candidate.userId] },
        dedupeKey: { $ifNull: ["$dedupeKey", candidate.dedupeKey] },
        bucket: { $ifNull: ["$bucket", candidate.bucket] },

        type: { $ifNull: ["$type", candidate.type] },
        title: { $ifNull: ["$title", candidate.title] },

        // Preserve status if user already ACK/CLOSED; otherwise default to OPEN
        status: { $ifNull: ["$status", candidate.status || "OPEN"] },

        createdAt: { $ifNull: ["$createdAt", now] },
        updatedAt: now,

        // Monotonic score
        score: { $max: [{ $ifNull: ["$score", 0] }, incomingScore] },

        // Update explain/meta only if incoming score strictly improves
        explain: {
          $cond: [
            { $gt: [incomingScore, { $ifNull: ["$score", 0] }] },
            candidate.explain,
            { $ifNull: ["$explain", candidate.explain] },
          ],
        },
        meta: {
          $cond: [
            { $gt: [incomingScore, { $ifNull: ["$score", 0] }] },
            candidate.meta,
            { $ifNull: ["$meta", candidate.meta] },
          ],
        },

        // Merge sources (set-union)
        sources: {
          $setUnion: [
            { $ifNull: ["$sources", []] },
            Array.isArray(candidate.sources) ? candidate.sources : [],
          ],
        },
      },
    },
  ];
}

async function recomputeAlertsForUser(userId, { windowHours = 24 } = {}) {
  const db = getMongoDb();
  const now = new Date();
  const since = new Date(now.getTime() - windowHours * 60 * 60 * 1000);

  // Pull recent signals (TTL collections)
  const [secSignals, mlSignals] = await Promise.all([
    db
      .collection("signals_security")
      .find({ userId, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray(),
    db
      .collection("signals_ml")
      .find({ userId, createdAt: { $gte: since } })
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray(),
  ]);

  const candidates = buildCandidates({
    secSignals,
    mlSignals,
    thresholds: {
      minSecurityRiskToAlert: 10,
      minMlSeverityToAlert: 60,
    },
  });

  const alertsCol = db.collection("alerts");

  let upserts = 0;
  let updates = 0;

  for (const c of candidates) {
    const filter = {
      userId: c.userId,
      dedupeKey: c.dedupeKey,
      bucket: c.bucket,
    };

    const pipeline = buildUpsertPipeline({ now, candidate: c });

    try {
      const res = await alertsCol.updateOne(filter, pipeline, { upsert: true });

      // With pipeline updates, upsertedCount is still populated for inserts
      if (res.upsertedCount) upserts += 1;
      else if (res.modifiedCount) updates += 1;
    } catch (e) {
      // If concurrent upserts race into unique constraint, retry without upsert
      const msg = String(e?.message || "");
      if (msg.includes("E11000")) {
        const res2 = await alertsCol.updateOne(filter, pipeline, { upsert: false });
        if (res2.modifiedCount) updates += 1;
        continue;
      }
      logger.error({ err: msg, dedupeKey: c.dedupeKey }, "alerts_upsert_failed");
      throw e;
    }
  }

  return {
    ok: true,
    userId,
    windowHours,
    signals: { security: secSignals.length, ml: mlSignals.length },
    candidates: candidates.length,
    upserts,
    updates,
  };
}

async function listAlertsForUser(userId, { status = "OPEN", limit = 50 } = {}) {
  const db = getMongoDb();
  const alertsCol = db.collection("alerts");

  const st = normalizeStatus(status);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));

  const docs = await alertsCol
    .find({ userId, status: st })
    .sort({ score: -1, createdAt: -1 }) // score-first is more useful operationally
    .limit(lim)
    .toArray();

  return { ok: true, status: st, count: docs.length, alerts: docs };
}

async function setAlertStatus({ userId, alertId, status }) {
  const db = getMongoDb();
  const alertsCol = db.collection("alerts");

  const st = normalizeStatus(status);
  const _id = new ObjectId(String(alertId));

  const res = await alertsCol.updateOne(
    { _id, userId },
    { $set: { status: st, updatedAt: new Date() } }
  );

  if (res.matchedCount === 0) {
    const err = new Error("Alert not found");
    err.status = 404;
    throw err;
  }

  return { ok: true, alertId: String(_id), status: st };
}

async function listAlertsAdmin({ status = "OPEN", limit = 200, userId = null, sinceHours = 24 } = {}) {
  const db = getMongoDb();
  const alertsCol = db.collection("alerts");

  const st = normalizeStatus(status);
  const lim = Math.max(1, Math.min(500, Number(limit) || 200));
  const hours = Math.max(1, Number(sinceHours) || 24);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const q = { status: st, createdAt: { $gte: since } };
  if (userId) q.userId = userId;

  const docs = await alertsCol
    .find(q)
    .sort({ score: -1, createdAt: -1 })
    .limit(lim)
    .toArray();

  return { ok: true, status: st, sinceHours: hours, count: docs.length, alerts: docs };
}


module.exports = {
  recomputeAlertsForUser,
  listAlertsForUser,
  listAlertsAdmin,
  setAlertStatus,
};
