const { env } = require("../config/env");

function requireInternalKey(req, _res, next) {
  try {
    const expected = env.INTERNAL_EXECUTOR_KEY;

    if (!expected) {
      const err = new Error("Internal executor key not configured");
      err.status = 500;
      err.code = "INTERNAL_KEY_MISSING";
      throw err;
    }

    const provided = String(req.headers["x-internal-key"] || "").trim();
    if (!provided || provided !== expected) {
      const err = new Error("Forbidden");
      err.status = 403;
      err.code = "INTERNAL_FORBIDDEN";
      throw err;
    }

    return next();
  } catch (e) {
    return next(e);
  }
}

module.exports = { requireInternalKey };
