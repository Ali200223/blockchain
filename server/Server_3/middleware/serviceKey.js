// server_2/middleware/serviceKey.js
module.exports = function serviceKey(req, res, next) {
  const expected = String(process.env.MARKET_DATA_SERVICE_API_KEY || "").trim();

  // Dev-friendly: if not set, allow.
  if (!expected) return next();

  const headerName = String(process.env.MARKET_DATA_API_KEY_HEADER || "x-api-key").toLowerCase();
  const provided = String(req.headers[headerName] || "").trim();

  if (!provided || provided !== expected) {
    return res.status(401).json({ ok: false, message: "Invalid service key" });
  }

  next();
};
