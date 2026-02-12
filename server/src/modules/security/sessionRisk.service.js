const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { pool } = require("../../config/mysql");
const { env } = require("../../config/env");
const { logSecurityEvent } = require("./securityLog.service");
const { trackDeviceAndIp, isNewDevice, isNewIp } = require("./securityTracking.service");
const { writeSecuritySignal } = require("../signals/signals.service");

const RULE_VERSION = "session_rule_v1";

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function clampScore(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

function decide(score) {
  if (score >= 70) return "BLOCK_SENSITIVE";
  if (score >= 35) return "STEP_UP_REQUIRED";
  return "ALLOW";
}

function controlsForAction(action) {
  if (action === "BLOCK_SENSITIVE") return ["FORCE_REAUTH", "LOCK_SENSITIVE_ACTIONS", "NOTIFY_USER"];
  if (action === "STEP_UP_REQUIRED") return ["REQUIRE_MFA", "EMAIL_OTP", "COOLDOWN"];
  return [];
}

// --- Stage C: ML anomaly scoring integration ---
const ML_PATH_CANDIDATES = [
  "/security/anomaly-score",
  "/security/anomaly/score",
  "/security/anomaly",
  "/anomaly/score",
  "/anomaly",
];

let _mlEndpointUrl = null;
let _mlBodyStyle = "camel"; // "camel" | "snake"

function buildMlFeatures(computed) {
  const stats = computed?.stats || {};
  const drift = computed?.drift || {};
  return {
    login_fail_15m: Number(stats.login_fail_15m || 0),
    login_success_5m: Number(stats.login_success_5m || 0),
    login_success_1h: Number(stats.login_success_1h || 0),
    distinct_ip_24h: Number(stats.distinct_ip_24h || 0),
    distinct_ip_7d: Number(drift.distinct_ip_7d || 0),
    distinct_ua_7d: Number(stats.distinct_ua_7d || 0),
    distinct_device_30d: Number(drift.distinct_device_30d || 0),
    ipDrift: computed?.ipDrift ? 1 : 0,
    uaDrift: computed?.uaDrift ? 1 : 0,
  };
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "");
  return b + (p.startsWith("/") ? p : `/${p}`);
}

function postJson(url, payload, { headers = {}, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }

    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;

    const body = JSON.stringify(payload ?? {});
    const req = lib.request(
      {
        method: "POST",
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search || ""}`,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode || 0, headers: res.headers || {}, text, json });
        });
      }
    );

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("ML request timeout")));

    req.write(body);
    req.end();
  });
}

function extractMl(resultJson) {
  const raw = resultJson && typeof resultJson === "object" ? resultJson : {};
  const modelVersion = raw.model_version ?? raw.modelVersion ?? raw.ml_version ?? raw.version ?? null;

  let score =
    raw.anomaly_score ??
    raw.anomalyScore ??
    raw.score ??
    raw.risk_score ??
    raw.riskScore ??
    raw.flat_score ??
    raw.flatScore ??
    raw.nested_score ??
    raw.nestedScore ??
    (raw.anomaly && (raw.anomaly.score ?? raw.anomaly.anomaly_score)) ??
    null;

  if (score == null && raw.output && typeof raw.output === "object") {
    score = raw.output.score ?? raw.output.anomaly_score ?? null;
  }

  const n = Number(score);
  const ok = Number.isFinite(n);
  const scoreRaw = ok ? n : null;
  const score100 = ok ? clampScore(n <= 1 ? n * 100 : n) : null;

  return { scoreRaw, score100, modelVersion };
}

function buildMlBodyCamel({ userId, sessionId, intent, ctx, features }) {
  return {
    userId,
    sessionId,
    intent,
    ip: ctx?.ip || null,
    ua: ctx?.ua || null,
    deviceId: ctx?.deviceId || null,
    features,
  };
}

function buildMlBodySnake({ userId, sessionId, intent, ctx, features }) {
  return {
    user_id: userId,
    session_id: sessionId,
    intent,
    ip: ctx?.ip || null,
    ua: ctx?.ua || null,
    device_id: ctx?.deviceId || null,
    features,
  };
}

async function scoreWithMl({ userId, sessionId, intent, ctx, features }) {
  const base = String(env.ML_SERVICE_URL || "").trim();
  if (!base) return { ok: false, error: "ML_SERVICE_URL not set" };

  const timeoutMs = Number(env.ML_SERVICE_TIMEOUT_MS || 8000);
  const retries = Number(env.ML_SERVICE_RETRIES || 0);

  const headers = {};
  if (env.ML_SERVICE_API_KEY) {
  headers["x-service-key"] = String(env.ML_SERVICE_API_KEY);
  
  headers["x-api-key"] = String(env.ML_SERVICE_API_KEY);
}


  const bodies = {
    camel: buildMlBodyCamel({ userId, sessionId, intent, ctx, features }),
    snake: buildMlBodySnake({ userId, sessionId, intent, ctx, features }),
  };

  const attemptOnce = async (endpointUrl, style) => {
    const res = await postJson(endpointUrl, bodies[style], { headers, timeoutMs });
    return { res, style };
  };

  const tryStyles = async (endpointUrl) => {
    const primary = _mlBodyStyle || "camel";
    const secondary = primary === "camel" ? "snake" : "camel";

    const a = await attemptOnce(endpointUrl, primary);
    if (a.res.status !== 422) return a;

    const b = await attemptOnce(endpointUrl, secondary);
    return b;
  };

  const candidates = _mlEndpointUrl ? [_mlEndpointUrl] : ML_PATH_CANDIDATES.map((p) => joinUrl(base, p));

  let lastErr = null;

  for (const endpointUrl of candidates) {
    for (let i = 0; i <= retries; i++) {
      try {
        const { res, style } = await tryStyles(endpointUrl);

        if (res.status === 404 && !_mlEndpointUrl) break;

        if (res.status >= 200 && res.status < 300) {
          const extracted = extractMl(res.json);

          _mlEndpointUrl = endpointUrl;
          _mlBodyStyle = style;

          return {
            ok: true,
            endpoint: endpointUrl,
            bodyStyle: style,
            scoreRaw: extracted.scoreRaw,
            score100: extracted.score100,
            modelVersion: extracted.modelVersion,
            raw: res.json,
          };
        }

        lastErr = new Error(`ML request failed (status ${res.status})`);
        lastErr.status = 502;
        lastErr.details = res.json || res.text;

        if (res.status >= 500 && res.status < 600 && i < retries) continue;
        break;
      } catch (e) {
        lastErr = e;
        if (i < retries) continue;
      }
    }
  }

  if (env.ML_DEBUG_ALLOW) {
    return { ok: false, error: String(lastErr?.message || "ml_failed"), details: lastErr?.details || null };
  }

  const err = lastErr || new Error("ML scoring failed");
  err.status = err.status || 502;
  throw err;
}

function ttlHoursDefault() {
  const raw = process.env.SESSION_TTL_HOURS || "24";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

function computeExpiresAt(hours) {
  const ms = Number(hours) * 3600 * 1000;
  return new Date(Date.now() + ms);
}

function normalizeCtx(ctx) {
  return {
    ip: ctx?.ip || null,
    ua: ctx?.ua || null,
    deviceId: ctx?.deviceId || null,
    requestId: ctx?.requestId || null,
  };
}

/**
 * Industrial fallback: if x-device-id not provided, derive a stable fingerprint.
 * Matches the spirit of auth.service deriveDeviceId.
 */
function deriveDeviceId(ctx) {
  if (ctx.deviceId) return { deviceId: ctx.deviceId, source: "header" };

  const basis = `${ctx.ua || ""}|${ctx.ip || ""}`.trim();
  if (!basis) return { deviceId: null, source: "none" };

  const h = sha256Hex(basis).slice(0, 32);
  return { deviceId: `fp_${h}`, source: "fingerprint" };
}

async function getActiveSessionByDevice(userId, deviceId) {
  if (!deviceId) return null;

  const [rows] = await pool.execute(
    `
    SELECT *
    FROM auth_sessions
    WHERE user_id = :userId AND is_active = true AND device_id = :deviceId
    LIMIT 1
    `,
    { userId, deviceId }
  );

  return rows[0] || null;
}

async function getSessionById(userId, sessionId) {
  const [rows] = await pool.execute(
    `SELECT * FROM auth_sessions WHERE id = :id AND user_id = :userId LIMIT 1`,
    { id: sessionId, userId }
  );
  return rows[0] || null;
}

async function startSession(userId, ctxRaw, { rotate = false, ttlHours } = {}) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  const ttl = ttlHours ? Number(ttlHours) : ttlHoursDefault();
  const expiresAt = computeExpiresAt(ttl);
  const contextHash = sha256Hex(`${ctx.ip || ""}|${ctx.ua || ""}`);

  const existing = await getActiveSessionByDevice(userId, ctx.deviceId);

  if (existing && !rotate) {
    await pool.execute(`UPDATE auth_sessions SET last_seen = NOW() WHERE id = :id`, { id: existing.id });

    await logSecurityEvent({
      userId,
      eventType: "SESSION_STARTED",
      ctx,
      metadata: {
        sessionId: existing.id,
        reused: true,
        deviceIdSource: d.source,
        expiresAt: existing.expires_at,
      },
    });

    return {
      sessionId: existing.id,
      reused: true,
      expiresAt: existing.expires_at,
      deviceId: existing.device_id,
    };
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (existing) {
      await conn.execute(
        `
        UPDATE auth_sessions
        SET is_active = false, ended_at = NOW(), ended_reason = 'rotated'
        WHERE id = :id
        `,
        { id: existing.id }
      );
    }

    const sessionId = crypto.randomUUID();

    await conn.execute(
      `
      INSERT INTO auth_sessions
        (id, user_id, device_id, ip, user_agent, context_hash, expires_at)
      VALUES
        (:id, :userId, :deviceId, :ip, :ua, :contextHash, :expiresAt)
      `,
      {
        id: sessionId,
        userId,
        deviceId: ctx.deviceId,
        ip: ctx.ip,
        ua: ctx.ua,
        contextHash,
        expiresAt,
      }
    );

    await conn.commit();

    await logSecurityEvent({
      userId,
      eventType: "SESSION_STARTED",
      ctx,
      metadata: {
        sessionId,
        reused: false,
        rotatedPrevious: Boolean(existing),
        deviceIdSource: d.source,
        expiresAt,
      },
    });

    return { sessionId, reused: false, expiresAt, deviceId: ctx.deviceId };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function computeRuleRisk(userId, session, ctx) {
  const [statsRows] = await pool.execute(
    `
    SELECT
      SUM(event_type = 'LOGIN_SUCCESS' AND created_at > NOW() - INTERVAL 5 MINUTE) AS login_success_5m,
      SUM(event_type = 'LOGIN_SUCCESS' AND created_at > NOW() - INTERVAL 1 HOUR) AS login_success_1h,
      SUM(event_type LIKE 'LOGIN_FAIL_%' AND created_at > NOW() - INTERVAL 15 MINUTE) AS login_fail_15m,
      COUNT(DISTINCT IF(created_at > NOW() - INTERVAL 24 HOUR, ip, NULL)) AS distinct_ip_24h,
      COUNT(DISTINCT IF(created_at > NOW() - INTERVAL 7 DAY, user_agent, NULL)) AS distinct_ua_7d
    FROM security_logs
    WHERE user_id = :userId
    `,
    { userId }
  );
  const stats = statsRows[0] || {};

  const [driftRows] = await pool.execute(
    `
    SELECT
      (SELECT COUNT(*) FROM user_devices WHERE user_id = :userId AND last_seen > NOW() - INTERVAL 30 DAY) AS distinct_device_30d,
      (SELECT COUNT(*) FROM user_ip_history WHERE user_id = :userId AND last_seen > NOW() - INTERVAL 7 DAY) AS distinct_ip_7d
    `,
    { userId }
  );
  const drift = driftRows[0] || {};

  const ipDrift = Boolean(session.ip && ctx.ip && session.ip !== ctx.ip);
  const ctxHashNow = sha256Hex(`${ctx.ip || ""}|${ctx.ua || ""}`);
  const uaDrift = Boolean(session.context_hash && ctxHashNow && session.context_hash !== ctxHashNow);

  const deviceNew = ctx.deviceId ? await isNewDevice(userId, ctx.deviceId) : false;
  const ipNew = ctx.ip ? await isNewIp(userId, ctx.ip) : false;

  await trackDeviceAndIp(userId, ctx);

  const factors = [];
  let score = 0;

  function add(code, weight, evidence) {
    score += weight;
    factors.push({ code, weight, evidence });
  }

  if (Number(stats.login_fail_15m || 0) >= 5) {
    add("LOGIN_FAIL_BURST_15M", 40, { login_fail_15m: Number(stats.login_fail_15m || 0) });
  }

  if (Number(stats.distinct_ip_24h || 0) >= 4) {
    add("DISTINCT_IP_24H_HIGH", 25, { distinct_ip_24h: Number(stats.distinct_ip_24h || 0) });
  }

  if (Number(stats.distinct_ua_7d || 0) >= 3) {
    add("DISTINCT_UA_7D_HIGH", 15, { distinct_ua_7d: Number(stats.distinct_ua_7d || 0) });
  }

  if (Number(drift.distinct_ip_7d || 0) >= 4) {
    add("IP_DIVERSITY_7D_HIGH", 10, { distinct_ip_7d: Number(drift.distinct_ip_7d || 0) });
  }

  if (Number(drift.distinct_device_30d || 0) >= 3) {
    add("DEVICE_DIVERSITY_30D_HIGH", 10, { distinct_device_30d: Number(drift.distinct_device_30d || 0) });
  }

  if (ipDrift) add("SESSION_IP_DRIFT", 15, { sessionIp: session.ip, currentIp: ctx.ip });
  if (uaDrift) add("SESSION_CONTEXT_DRIFT", 10, { sessionContextHash: session.context_hash, currentContextHash: ctxHashNow });

  const ageMs = Date.now() - new Date(session.started_at).getTime();
  if (ageMs < 2 * 60 * 1000 && (deviceNew || ipNew)) {
    add("EARLY_SESSION_NOVEL_CONTEXT", 10, { ageSeconds: Math.floor(ageMs / 1000), deviceNew, ipNew });
  }

  score = clampScore(score);
  const action = decide(score);

  const controls =
    action === "BLOCK_SENSITIVE"
      ? ["FORCE_REAUTH", "LOCK_SENSITIVE_ACTIONS", "NOTIFY_USER"]
      : action === "STEP_UP_REQUIRED"
      ? ["REQUIRE_MFA", "EMAIL_OTP", "COOLDOWN"]
      : [];

  return {
    score,
    action,
    controls,
    factors,
    stats,
    drift,
    ipDrift,
    uaDrift,
    deviceNew,
    ipNew,
    ruleVersion: RULE_VERSION,
  };
}

async function scoreSession(userId, ctxRaw, { sessionId, intent, persist = true } = {}) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  let session = null;
  if (sessionId) {
    session = await getSessionById(userId, sessionId);
  } else if (ctx.deviceId) {
    session = await getActiveSessionByDevice(userId, ctx.deviceId);
  }

  if (!session) {
    const started = await startSession(userId, ctx, { rotate: false });
    session = await getSessionById(userId, started.sessionId);
  }

  if (!session.is_active) {
    throw Object.assign(new Error("Session is not active"), { status: 409 });
  }

  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    await pool.execute(
      `UPDATE auth_sessions SET is_active = false, ended_at = NOW(), ended_reason = 'expired' WHERE id = :id`,
      { id: session.id }
    );
    throw Object.assign(new Error("Session expired"), { status: 409 });
  }

  const computed = await computeRuleRisk(userId, session, ctx);

  const mlFeatures = buildMlFeatures(computed);

  let ml = { ok: false, scoreRaw: null, score100: null, modelVersion: null, endpoint: null };
  try {
    ml = await scoreWithMl({ userId, sessionId: session.id, intent: intent || null, ctx, features: mlFeatures });
  } catch (e) {
    if (!env.ML_DEBUG_ALLOW) throw e;
    ml = { ok: false, error: String(e?.message || "ml_failed"), details: e?.details || null };
  }

  const ruleRisk = computed.score;
  const mlRisk = ml.ok ? ml.score100 : null;
  const finalRisk = mlRisk == null ? ruleRisk : clampScore(Math.max(ruleRisk, mlRisk));
  const finalAction = decide(finalRisk);
  const finalControls = controlsForAction(finalAction);

  const payload = {
    sessionId: session.id,
    userId,
    intent: intent || null,

    risk: finalRisk,
    action: finalAction,
    controls: finalControls,

    ruleRisk,
    mlRisk,

    ruleVersion: computed.ruleVersion,
    mlVersion: ml.ok ? ml.modelVersion : null,

    factors: computed.factors,
    evidence: {
      stats: computed.stats,
      drift: computed.drift,
      ipDrift: computed.ipDrift,
      uaDrift: computed.uaDrift,
      mlFeatures,
    },
    ml: ml.ok
      ? { ok: true, endpoint: ml.endpoint, bodyStyle: ml.bodyStyle, scoreRaw: ml.scoreRaw, score100: ml.score100 }
      : { ok: false, error: ml.error || null },
  };

  if (persist) {
    if (ml?.ok) {
      try {
        await pool.execute(
          `
          INSERT INTO session_ml_anomaly_scores
            (session_id, user_id, intent, anomaly_score, model_version, features, raw_response)
          VALUES
            (:sessionId, :userId, :intent, :anomalyScore, :modelVersion, :features, :rawResponse)
          `,
          {
            sessionId: session.id,
            userId,
            intent: intent || null,
            anomalyScore: ml.scoreRaw ?? 0,
            modelVersion: ml.modelVersion || null,
            features: JSON.stringify(mlFeatures),
            rawResponse: JSON.stringify(ml.raw || {}),
          }
        );
      } catch (e) {
        await logSecurityEvent({
          userId,
          eventType: "SESSION_ML_AUDIT_WRITE_FAILED",
          ctx,
          metadata: { sessionId: session.id, err: String(e?.message || e) },
        });
      }
    }

    await pool.execute(
      `
      INSERT INTO session_risk_scores
        (session_id, user_id, risk_score, action, rule_version, ml_version, factors, ctx)
      VALUES
        (:sessionId, :userId, :risk, :action, :ruleVersion, :mlVersion, :factors, :ctx)
      `,
      {
        sessionId: session.id,
        userId,
        risk: finalRisk,
        action: finalAction,
        ruleVersion: computed.ruleVersion,
        mlVersion: payload.mlVersion,
        factors: JSON.stringify({
          factors: computed.factors,
          controls: finalControls,
          intent: intent || null,
          ruleRisk,
          mlRisk,
          ml: payload.ml,
        }),
        ctx: JSON.stringify({ ip: ctx.ip, ua: ctx.ua, deviceId: ctx.deviceId, requestId: ctx.requestId }),
      }
    );

    await pool.execute(
      `
      UPDATE auth_sessions
      SET last_seen = NOW(),
          last_risk_score = :risk,
          last_action = :action,
          last_scored_at = NOW()
      WHERE id = :id
      `,
      { id: session.id, risk: finalRisk, action: finalAction }
    );
  }

  // TTL signal for Alert Engine (non-blocking) — UPDATED PAYLOAD (main work)
 // TTL signal for Alert Engine (non-blocking)
void writeSecuritySignal({
  userId,
  createdAt: new Date(),
  signalType: "SESSION_RISK",

  sessionId: session?.id ?? sessionId ?? null,

  // --- fields alerts.service.js reads ---
  risk: finalRisk,                         // alias for alerts
  action: finalAction,
  factors: (computed?.factors ?? []).map((f) => ({ code: f.code, weight: f.weight })), // compact

  // --- keep existing fields for backward compatibility / other readers ---
  score100: finalRisk,
  factorsSummary: (computed?.factors ?? []).map((f) => ({ code: f.code, weight: f.weight })),

  ruleRisk,
  mlRisk,
  ruleVersion: computed?.ruleVersion ?? RULE_VERSION,
  mlVersion: payload?.mlVersion ?? null,

  ctx: {
    ip: ctx?.ip ?? null,
    ua: ctx?.ua ?? null,
    deviceId: ctx?.deviceId ?? null,
    requestId: ctx?.requestId ?? null,
  },
}).catch((e) =>
  logSecurityEvent({
    userId,
    eventType: "SECURITY_SIGNAL_PERSIST_FAILED",
    ctx,
    metadata: { message: String(e?.message || e) },
  })
);


  await logSecurityEvent({
    userId,
    eventType: "SESSION_RISK_SCORED",
    ctx,
    metadata: payload,
  });

  return payload;
}

async function getCurrentSession(userId, ctxRaw) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  const session = ctx.deviceId ? await getActiveSessionByDevice(userId, ctx.deviceId) : null;
  if (!session) return null;

  return {
    sessionId: session.id,
    startedAt: session.started_at,
    lastSeen: session.last_seen,
    expiresAt: session.expires_at,
    lastRisk: session.last_risk_score,
    lastAction: session.last_action,
    lastScoredAt: session.last_scored_at,
    deviceId: session.device_id,
  };
}

async function endSession(userId, ctxRaw, { sessionId, reason } = {}) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  let session = null;
  if (sessionId) {
    session = await getSessionById(userId, sessionId);
  } else if (ctx.deviceId) {
    session = await getActiveSessionByDevice(userId, ctx.deviceId);
  }

  if (!session) return { ok: true, ended: false, reason: "no_active_session" };

  await pool.execute(
    `
    UPDATE auth_sessions
    SET is_active = false, ended_at = NOW(), ended_reason = :reason
    WHERE id = :id AND user_id = :userId
    `,
    { id: session.id, userId, reason: reason || "user_logout" }
  );

  await logSecurityEvent({
    userId,
    eventType: "SESSION_ENDED",
    ctx,
    metadata: { sessionId: session.id, reason: reason || "user_logout" },
  });

  return { ok: true, ended: true, sessionId: session.id };
}

module.exports = {
  startSession,
  scoreSession,
  getCurrentSession,
  endSession,
};
