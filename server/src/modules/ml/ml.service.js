const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { ObjectId } = require("mongodb");


const { getMongoDb } = require("../../config/mongo");
const { env } = require("../../config/env");
const { logger } = require("../../config/logger");
const { logSecurityEvent } = require("../security/securityLog.service");

function postJson(urlStr, bodyObj, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const isHttps = url.protocol === "https:";
    const lib = isHttps ? https : http;

    const body = Buffer.from(JSON.stringify(bodyObj), "utf8");

    const req = lib.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers: {
          "content-type": "application/json",
          "content-length": body.length,
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = { raw: data };
          }

          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(
              `ML service error (${res.statusCode}): ${json?.detail || json?.error || "unknown"}`
            );
            err.status = 502;
            err.details = json;
            err.httpStatus = res.statusCode;
            return reject(err);
          }

          resolve(json);
        });
      }
    );

    req.on("timeout", () => req.destroy(new Error("ML service timeout")));

    req.on("error", (e) => {
      const err = new Error(`ML service unreachable: ${e.message}`);
      err.status = 502;
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

function normalizeBaseUrl(u) {
  return String(u || "").replace(/\/+$/, "");
}

function sanitizeMlOutputForStorage(json) {
  
  if (!json || typeof json !== "object") return json;

  const shallow = { ...json };

  const heavyKeys = [
    "debug",
    "debugUsed",
    "debugFeatures",
    "debugEdges",
    "features",
    "edges",
    "adjacency",
    "graph",
    "contributions",
    "topContributions",
    "indirectContributions",
    "nodeFeatures",
  ];

  for (const k of heavyKeys) {
    if (k in shallow) delete shallow[k];
  }

  
  return shallow;
}

function summarizePredictionsForSignal(json) {
  const preds = Array.isArray(json?.predictions) ? json.predictions : [];

  const items = preds.map((p) => {
    const symbol = String(p?.symbol || p?.asset || "").toUpperCase() || "UNKNOWN";

    
    const pUpRaw = p?.p_up ?? p?.prob_up ?? p?.probability_up ?? p?.up_prob;
    const expRetRaw = p?.exp_return ?? p?.expected_return ?? p?.predicted_return ?? p?.return;
    const confRaw = p?.confidence ?? p?.conf ?? p?.score ?? null;

    const pUp = Number.isFinite(Number(pUpRaw)) ? Math.max(0, Math.min(1, Number(pUpRaw))) : null;
    const expReturn = Number.isFinite(Number(expRetRaw)) ? Number(expRetRaw) : null;
    const confidence = Number.isFinite(Number(confRaw)) ? Math.max(0, Math.min(1, Number(confRaw))) : 0.5;

    
    let direction = "NEUTRAL";
    if (expReturn !== null) direction = expReturn > 0 ? "BULLISH" : expReturn < 0 ? "BEARISH" : "NEUTRAL";
    else if (pUp !== null) direction = pUp >= 0.55 ? "BULLISH" : pUp <= 0.45 ? "BEARISH" : "NEUTRAL";

    
    const severityScore100 = Math.max(0, Math.min(100, Math.round(confidence * 100)));

    return { symbol, direction, severityScore100, confidence, pUp, expReturn };
  });

  const maxSeverityScore100 = items.reduce((m, x) => Math.max(m, x.severityScore100 || 0), 0);
  return { items, maxSeverityScore100 };
}


async function pricePrediction({ userId, ctx, input }) {
  const baseUrl = normalizeBaseUrl(env.ML_SERVICE_URL);
  if (!baseUrl) {
    const err = new Error("ML_SERVICE_URL is not configured");
    err.status = 500;
    throw err;
  }

  const requestId = crypto.randomUUID();
  const started = Date.now();

  await logSecurityEvent({
    userId,
    eventType: "ML_PRICE_PREDICTION_REQUEST",
    ctx,
    metadata: {
      requestId,
      interval: input.interval,
      horizon: input.horizon,
      symbolsCount: input.symbols.length,
      debugRequested: Boolean(input.debugFeatures || input.debugEdges),
    },
  });

  const headers = { "x-request-id": requestId };
  if (env.ML_SERVICE_API_KEY) headers["x-service-key"] = env.ML_SERVICE_API_KEY;

  const timeoutMs = Number(env.ML_SERVICE_TIMEOUT_MS || 8000);
  const maxRetries = Number(env.ML_SERVICE_RETRIES || 0);

  logger.info({ requestId, baseUrl, userId, timeoutMs, maxRetries }, "ml_predict_start");

  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const json = await postJson(`${baseUrl}/predict`, input, headers, timeoutMs);
      const latencyMs = Date.now() - started;

      await logSecurityEvent({
        userId,
        eventType: "ML_PRICE_PREDICTION_RESPONSE",
        ctx,
        metadata: {
          requestId,
          latencyMs,
          attempt,
          model: json?.model,
          predictionsCount: json?.predictions?.length || 0,
          debugUsed: json?.debugUsed ?? null,
        },
      });


          
      try {
        const db = getMongoDb();
        const createdAt = new Date();

        const sanitizedInput = {
          symbols: input?.symbols,
          interval: input?.interval,
          horizon: input?.horizon,
          asOf: input?.asOf ?? null,
          includePropagation: Boolean(input?.includePropagation),
          debugRequested: Boolean(input?.debugFeatures || input?.debugEdges),
        };

        const durableOutput = sanitizeMlOutputForStorage(json);

       
        const ins = await db.collection("ml_predictions").insertOne({
          userId,
          createdAt,
          requestId,
          latencyMs,
          input: sanitizedInput,
          model: durableOutput?.model ?? json?.model ?? null,
          asOfTime: durableOutput?.asOfTime ?? json?.asOfTime ?? null,
          interval: durableOutput?.interval ?? json?.interval ?? sanitizedInput.interval ?? null,
          horizon: durableOutput?.horizon ?? json?.horizon ?? sanitizedInput.horizon ?? null,
          output: durableOutput,
        });

        const predictionId = ins.insertedId;

        
        const { items, maxSeverityScore100 } = summarizePredictionsForSignal(json);

        await db.collection("signals_ml").insertOne({
          userId,
          createdAt,
          signalType: "PRICE_PREDICTION",
          predictionId,
          requestId,
          model: json?.model ?? null,
          asOfTime: json?.asOfTime ?? null,
          interval: json?.interval ?? sanitizedInput.interval ?? null,
          horizon: json?.horizon ?? sanitizedInput.horizon ?? null,
          maxSeverityScore100,
          items,
        });
      } catch (e) {
        logger.warn({ requestId, err: String(e?.message || e) }, "ml_predict_persist_failed");
        await logSecurityEvent({
          userId,
          eventType: "ML_PREDICTION_PERSIST_FAILED",
          ctx,
          metadata: { requestId, message: String(e?.message || e) },
        });
      }


      logger.info({ requestId, latencyMs, attempt }, "ml_predict_ok");
      return { requestId, latencyMs, ...json };
    } catch (e) {
      lastErr = e;
      const isTimeout = String(e?.message || "").toLowerCase().includes("timeout");
      const isRetryable = isTimeout || e?.status === 502;

      logger.warn({ requestId, attempt, err: e?.message }, "ml_predict_attempt_failed");

      if (attempt >= maxRetries || !isRetryable) break;

      const backoffMs = 150 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }

  const latencyMs = Date.now() - started;

  await logSecurityEvent({
    userId,
    eventType: "ML_PRICE_PREDICTION_ERROR",
    ctx,
    metadata: {
      requestId,
      latencyMs,
      message: lastErr?.message,
      details: lastErr?.details,
    },
  });

  logger.error({ requestId, err: lastErr }, "ml_predict_failed");
  throw lastErr;
}

async function listPredictions({ userId, limit = 50, beforeId = null }) {
  const db = getMongoDb();

  const filter = { userId: String(userId) };
  if (beforeId) filter._id = { $lt: new ObjectId(beforeId) };

  const rows = await db
    .collection("ml_predictions")
    .find(filter, {
      projection: {
        userId: 0, // never return userId in API response
      },
    })
    .sort({ _id: -1 })
    .limit(Number(limit))
    .toArray();

  const items = rows.map((d) => ({
    id: String(d._id),
    createdAt: d.createdAt,
    requestId: d.requestId,
    latencyMs: d.latencyMs,
    input: d.input,
    model: d.model,
    asOfTime: d.asOfTime,
    interval: d.interval,
    horizon: d.horizon,
    output: d.output, // already sanitized at write-time
  }));

  const nextCursor = items.length === Number(limit) ? items[items.length - 1].id : null;
  return { items, nextCursor };
}


module.exports = { pricePrediction,listPredictions};
