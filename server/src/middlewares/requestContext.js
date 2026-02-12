const { randomUUID } = require("crypto");

function requestContext(req, res, next) {
  const inbound = req.headers["x-request-id"];
  const requestId =
    (typeof inbound === "string" && inbound.trim().slice(0, 64)) || randomUUID();

  const xf = req.headers["x-forwarded-for"];
  const ip = typeof xf === "string" && xf.trim() ? xf.split(",")[0].trim() : req.ip;

  const ua = req.headers["user-agent"] || null;

  const raw = req.headers["x-device-id"];
  const deviceId = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : null;

  req.ctx = { requestId, ip, ua, deviceId };
  res.setHeader("x-request-id", requestId);

  next();
}

module.exports = { requestContext };
