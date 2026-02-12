const router = require("express").Router();
const { authJwt } = require("../../middlewares/authJwt");
const { env } = require("../../config/env");
const { runWeeklyMlTrainingOnce } = require("../../jobs/weeklyMlTraining.job");


function requireAdmin(req, res, next) {
  const a = req.auth || {};
  const role = typeof a.role === "string" ? a.role.toLowerCase() : null;
  const roles = Array.isArray(a.roles) ? a.roles.map((r) => String(r).toLowerCase()) : [];
  const adminIds = String(env.ADMIN_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const isAdmin =
    a.isAdmin === true ||
    role === "admin" ||
    roles.includes("admin") ||
    (a.userId != null && adminIds.includes(String(a.userId)));

  if (!isAdmin) return res.status(403).json({ message: "Forbidden" });
  next();
}

router.post("/weekly-train/run", authJwt, requireAdmin, async (req, res) => {
  
  runWeeklyMlTrainingOnce().catch(() => {});
  res.json({ ok: true, started: true });
});

module.exports = router;
