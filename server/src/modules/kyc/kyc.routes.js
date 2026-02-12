const express = require("express");
const router = express.Router();

const { authJwt } = require("../../middlewares/authJwt");
const controller = require("./kyc.controller");
const { env } = require("../../config/env");

// All KYC routes require auth
router.use(authJwt);

// ---------- User routes ----------
router.post("/submit", controller.submit);
router.get("/status", controller.status);
router.post("/documents", controller.uploadKycDocument);

function parseCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------- Admin gate ----------
function requireAdmin(req, res, next) {
  const a = req.auth || {};
  const role = typeof a.role === "string" ? a.role.trim().toLowerCase() : "";
  const roles = Array.isArray(a.roles) ? a.roles.map((r) => String(r).trim().toLowerCase()) : [];

  // Support both env export and raw process.env (some modules already do this)
  const adminIds = parseCsv(env.ADMIN_USER_IDS || process.env.ADMIN_USER_IDS);
  const userId = a.userId != null ? String(a.userId) : "";

  const idAdmin = userId && adminIds.includes(userId);
  const isAdmin = a.isAdmin === true || role === "admin" || roles.includes("admin") || idAdmin;

  if (!isAdmin) return res.status(403).json({ ok: false, error: "Admin only" });

  // Normalize so controller-level checks (req.auth.isAdmin / role) behave consistently
  req.auth = {
    ...a,
    isAdmin: true,
    role: "admin",
    roles: Array.from(new Set([...(roles || []), "admin"])),
  };

  return next();
}

// ---------- Admin routes ----------
const admin = express.Router();
admin.use(requireAdmin);

admin.get("/applications", controller.listApplications);
admin.post("/review", controller.review);
admin.post("/reveal-doc-number", controller.revealDocNumber);


admin.get("/documents", controller.adminListDocuments);

admin.get("/documents/:id/file", controller.adminDownloadDocument);

router.use("/admin", admin);

module.exports = router;
