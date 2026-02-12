const jwt = require("jsonwebtoken");
const { env } = require("../config/env");

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

   

    // Hardening: allow-list algorithms (matches your HS* secrets model)
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      clockTolerance: 5, // seconds (minor skew tolerance)
    });

    if (!payload?.sub || typeof payload.sub !== "string") {
      const err = new Error("Invalid token subject");
      err.status = 401;
      err.code = "AUTH_INVALID";
      throw err;
    }

    const role = typeof payload.role === "string" ? payload.role.toLowerCase() : "user";
    const roles = Array.isArray(payload.roles)
      ? payload.roles.map((r) => String(r).toLowerCase())
      : [];

    req.auth = {
      userId: payload.sub,
      role,
      roles,
      isAdmin: payload.isAdmin === true || role === "admin" || roles.includes("admin"),
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
    next(e);
  }
}

module.exports = {authJwt} ;
