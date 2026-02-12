const svc = require("./sessionRisk.service");
const {
  startSessionSchema,
  scoreSessionSchema,
  endSessionSchema,
} = require("./sessionRisk.validators");

function getCtx(req) {
  // Prefer canonical requestContext middleware
  if (req.ctx) return req.ctx;

  const raw = req.headers["x-device-id"];
  const deviceId = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : null;

  return {
    requestId: req.headers["x-request-id"]?.toString().slice(0, 64) || null,
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip,
    ua: req.headers["user-agent"] || null,
    deviceId,
  };
}

async function start(req, res, next) {
  try {
    const body = startSessionSchema.parse(req.body || {});
    const out = await svc.startSession(req.auth.userId, getCtx(req), body);
    res.json({ ok: true, session: out });
  } catch (e) {
    next(e);
  }
}

async function score(req, res, next) {
  try {
    const body = scoreSessionSchema.parse(req.body || {});
    const out = await svc.scoreSession(req.auth.userId, getCtx(req), body);
    res.json({ ok: true, score: out });
  } catch (e) {
    next(e);
  }
}

async function current(req, res, next) {
  try {
    const out = await svc.getCurrentSession(req.auth.userId, getCtx(req));
    res.json({ ok: true, session: out });
  } catch (e) {
    next(e);
  }
}

async function end(req, res, next) {
  try {
    const body = endSessionSchema.parse(req.body || {});
    const out = await svc.endSession(req.auth.userId, getCtx(req), body);
    res.json(out);
  } catch (e) {
    next(e);
  }
}

module.exports = { start, score, current, end };
