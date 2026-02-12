const router = require("express").Router();
const { pool } = require("../../config/mysql");
const { authJwt } = require("../../middlewares/authJwt");
const { requireOwnerOrAdmin } = require("../../middlewares/requireOwnerOrAdmin");
const controller = require("./ledger.controller");

// Admin-only endpoints (controller enforces role)
router.post("/admin/commit", authJwt, controller.adminCommit);
router.get("/admin/verify", authJwt, controller.adminVerify);

router.get("/admin/blocks", authJwt, controller.adminListBlocks);
router.get("/admin/blocks/:height", authJwt, controller.adminGetBlockByHeight);

// Lock diagnostics + admin recovery
router.get("/admin/locks", authJwt, controller.adminListLocks);
router.post("/admin/unlock", authJwt, controller.adminUnlock);

// Finalization + audit trail
router.post("/admin/finalize/:height", authJwt, controller.adminFinalize);
router.get("/admin/actions", authJwt, controller.adminListActions);


// -------------------------
// Audit ledger (admin only)
// -------------------------
router.post("/admin/audit/commit", authJwt, controller.adminAuditCommit);
router.get("/admin/audit/verify", authJwt, controller.adminAuditVerify);

router.get("/admin/audit/blocks", authJwt, controller.adminAuditListBlocks);
router.get("/admin/audit/blocks/:height", authJwt, controller.adminAuditGetBlockByHeight);

router.get("/admin/audit/locks", authJwt, controller.adminAuditListLocks);
router.post("/admin/audit/unlock", authJwt, controller.adminAuditUnlock);

router.post("/admin/audit/finalize/:height", authJwt, controller.adminAuditFinalize);
router.get("/admin/audit/actions", authJwt, controller.adminAuditListActions);


// -------------------------
// Receipts (owner or admin)
// -------------------------

router.get(
  "/receipt/wallet/:txId",
  authJwt,
  requireOwnerOrAdmin(async (req) => {
    const txId = Number(req.params.txId);
    if (!Number.isFinite(txId) || txId <= 0) return null;

    const [rows] = await pool.query(
      `SELECT user_id FROM wallet_transactions WHERE id = ?`,
      [txId]
    );
    return rows[0]?.user_id ? String(rows[0].user_id) : null;
  }),
  controller.walletReceipt
);

router.get(
  "/receipt/security/:logId",
  authJwt,
  requireOwnerOrAdmin(async (req) => {
    const logId = Number(req.params.logId);
    if (!Number.isFinite(logId) || logId <= 0) return null;

    // IMPORTANT:
    // If your table name differs, update it here (e.g. security_audit_logs vs security_logs).
    const [rows] = await pool.query(
      `SELECT user_id FROM security_logs WHERE id = ?`,
      [logId]
    );
    return rows[0]?.user_id ? String(rows[0].user_id) : null;
  }),
  controller.securityReceipt
);

router.get(
  "/receipt/trade/:tradeId",
  authJwt,
  requireOwnerOrAdmin(async (req) => {
    const tradeId = Number(req.params.tradeId);
    if (!Number.isFinite(tradeId) || tradeId <= 0) return null;

    const [rows] = await pool.query(
      `SELECT user_id FROM trade_fills WHERE id = ?`,
      [tradeId]
    );
    return rows[0]?.user_id ? String(rows[0].user_id) : null;
  }),
  controller.tradeReceipt
);

module.exports = router;
