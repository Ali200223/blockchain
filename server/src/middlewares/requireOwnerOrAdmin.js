// server/src/middlewares/requireOwnerOrAdmin.js

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function getActorId(req) {
  // Your authJwt sets req.auth.userId (payload.sub)
  return String(
    req?.auth?.userId ??
      // fallbacks (harmless if unused)
      req?.user?.id ??
      req?.user?.userId ??
      req?.user?.sub ??
      req?.userId ??
      ""
  );
}

function isAdmin(req) {
  // Support multiple conventions (role, roles[], isAdmin flag)
  if (req?.auth?.isAdmin === true) return true;

  const role = String(req?.auth?.role ?? req?.user?.role ?? "").toLowerCase();
  if (role === "admin") return true;

  const roles = Array.isArray(req?.auth?.roles)
    ? req.auth.roles.map((r) => String(r).toLowerCase())
    : Array.isArray(req?.user?.roles)
      ? req.user.roles.map((r) => String(r).toLowerCase())
      : [];

  return roles.includes("admin");
}

function requireOwnerOrAdmin(resolveOwnerId) {
  return async (req, _res, next) => {
    try {
      const ownerId = await resolveOwnerId(req);
      if (!ownerId) throw httpError(404, "Resource not found");

      const actorId = getActorId(req);
      if (!actorId) throw httpError(401, "Unauthorized");

      if (isAdmin(req) || String(ownerId) === actorId) return next();
      throw httpError(403, "Forbidden");
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { requireOwnerOrAdmin };
