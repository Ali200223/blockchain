const jwt = require("jsonwebtoken");
const { env } = require("../../src/config/env");

function authJwt(req, _res, next) {
  try {
    const header = req.headers.authorization;

    if (!header || !header.startsWith("Bearer ")) {
      const err = new Error("Missing Authorization Bearer token");
      err.status = 401;
      err.code = "AUTH_MISSING";
      throw err;
    }

    const token = header.slice("Bearer ".length).trim();

    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      clockTolerance: 5,
    });

    if (!payload?.sub || typeof payload.sub !== "string") {
      const err = new Error("Invalid token subject");
      err.status = 401;
      err.code = "AUTH_INVALID";
      throw err;
    }

    // IMPORTANT: store the RAW token string
    req.auth = {
      userId: payload.sub,
      role: payload.role || "user",
      token, // <-- FIX (was token.access)
    };

    next();
  } catch (e) {
    const name = String(e?.name || "");

    if (name === "TokenExpiredError") {
      const err = new Error("Access token expired");
      err.status = 401;
      err.code = "AUTH_EXPIRED";
      return next(err);
    }

    if (!e.status) e.status = 401;
    if (!e.code) e.code = "AUTH_FAILED";
    return next(e);
  }
}

module.exports = authJwt ;
