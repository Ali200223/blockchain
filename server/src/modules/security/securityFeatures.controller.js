const service = require("./securityFeatures.service");

function getCtx(req) {
  const raw = req.headers["x-device-id"];
  const deviceId = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : null;

  return {
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip,
    ua: req.headers["user-agent"] || null,
    deviceId,
  };
}

async function me(req, res, next) {
  try {
    const out = await service.getMyFeatures(req.auth.userId, getCtx(req));
    res.json({ ok: true, features: out });
  } catch (e) {
    next(e);
  }
}

module.exports = { me };
