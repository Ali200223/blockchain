const { env } = require("../../config/env");
const service = require("./ml.service");
const { pricePredictionSchema, listPredictionsQuerySchema } = require("./ml.validators");
const { logSecurityEvent } = require("../security/securityLog.service");

async function pricePrediction(req, res, next) {
  try {
    const input = pricePredictionSchema.parse(req.body || {});
    input.symbols = [...new Set(input.symbols.map((s) => s.trim().toUpperCase()))];

    // Detect debug injection attempt
    const debugAttempted = Boolean(input.debugFeatures || input.debugEdges);

    // Safety gate: debug injection only allowed when explicitly enabled
    if (debugAttempted && !env.ML_DEBUG_ALLOW) {
      // 1) audit it
      await logSecurityEvent({
        userId: req.auth?.userId || null,
        eventType: "ML_DEBUG_BLOCKED",
        ctx: req.ctx,
        metadata: {
          route: "POST /api/ml/price-prediction",
          hasDebugFeatures: Boolean(input.debugFeatures),
          hasDebugEdges: Boolean(input.debugEdges),
        },
      });

      // 2) recommended: hard-block (clean signal that this is not allowed)
      const err = new Error("Debug injection disabled");
      err.status = 403;
      throw err;

      // If you prefer silent stripping instead of 403, comment the 2 lines above,
      // and keep the deletes below.
    }

    // If debug is disabled but we chose NOT to hard-block, strip fields
    if (!env.ML_DEBUG_ALLOW) {
      delete input.debugFeatures;
      delete input.debugEdges;
    }

    const out = await service.pricePrediction({
      userId: req.auth.userId,
      ctx: req.ctx,
      input,
    });

    res.json({ ok: true, result: out, requestId: req.ctx?.requestId });
  } catch (e) {
    next(e);
  }
}
async function listPredictions(req, res, next) {
  try {
    const q = listPredictionsQuerySchema.parse(req.query || {});
    const out = await service.listPredictions({
      userId: req.auth.userId,
      limit: q.limit,
      beforeId: q.beforeId || null,
    });
    res.json({ ok: true, ...out, requestId: req.ctx?.requestId });
  } catch (e) {
    next(e);
  }
}
module.exports = { pricePrediction,listPredictions };
