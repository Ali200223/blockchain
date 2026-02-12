const service = require("./securityEvents.service");
const { logSecurityEvent } = require("./securityLog.service");

function getCtx(req) {
  const raw = req.headers["x-device-id"];
  const deviceId = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : null;

  return {
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip,
    ua: req.headers["user-agent"] || null,
    deviceId,
  };
}

function clampLimit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(200, Math.floor(n)));
}

async function meEvents(req, res, next) {
  try {
    const ctx = getCtx(req);
    const limit = clampLimit(req.query?.limit);

    const result = await service.getMyEvents(req.auth.userId, limit);

    // Optional but realistic audit log of viewing events
    await logSecurityEvent({
      userId: req.auth.userId,
      eventType: "SECURITY_EVENTS_VIEWED",
      ctx,
      metadata: { limit: result.limit }, // (optional) keep accurate
    });

    res.json({ ok: true, events: result });
  } catch (e) {
    next(e);
  }
}

// Export both names so routes can't mismatch again
module.exports = { meEvents, me: meEvents };
