// server/src/modules/alerts/alerts.routes.js
const express = require("express");
const { authJwt } = require("../../middlewares/authJwt");
const { env } = require("../../config/env");
const controller = require("./alerts.controller");

const router = express.Router();

router.use(authJwt);

function parseCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Robust admin gate (works with role, roles[], isAdmin, or ADMIN_USER_IDS)
function requireAdmin(req, res, next) {
  const a = req.auth || {};

  const role = typeof a.role === "string" ? a.role.trim().toLowerCase() : "";
  const roles = Array.isArray(a.roles) ? a.roles.map((r) => String(r).trim().toLowerCase()) : [];

  // IMPORTANT: env.ADMIN_USER_IDS is not exported by env.js in your repo,
  // so we fallback to process.env.ADMIN_USER_IDS.
  const adminIds = parseCsv(env.ADMIN_USER_IDS || process.env.ADMIN_USER_IDS);

  const userId = a.userId != null ? String(a.userId) : "";

  const isAdmin =
    a.isAdmin === true ||
    role === "admin" ||
    roles.includes("admin") ||
    (userId && adminIds.includes(userId));

  if (isAdmin) return next();
  return res.status(403).json({ ok: false, error: "admin_required" });
}

router.get("/", controller.list);
router.get("/admin", requireAdmin, controller.listAdmin);
router.post("/recompute", controller.recompute);
router.patch("/:id", controller.patchStatus);

module.exports = router;
