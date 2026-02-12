// server/src/jobs/auditLedgerAutoCommit.job.js
const { logger } = require("../config/logger");
const ledgerService = require("../modules/ledger/ledger.service");

function startAuditLedgerAutoCommitJob() {
  const enabled = String(process.env.AUDIT_AUTOCOMMIT_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.AUDIT_AUTOCOMMIT_INTERVAL_MS || "5000");
  const maxItems = Number(process.env.AUDIT_AUTOCOMMIT_MAX_ITEMS || "500");
  const systemUserId = String(process.env.SYSTEM_LEDGER_USER_ID || "SYSTEM");

  logger.info({ intervalMs, maxItems }, "audit_ledger_autocommit_job_started");

  setInterval(async () => {
    try {
      const out = await ledgerService.commitNextAuditBlock({
        sealedByUserId: systemUserId,
        maxItems,
        meta: {
          requestId: "job:audit_ledger_autocommit",
          adminUserId: systemUserId,
          ip: null,
          userAgent: "audit-ledger-autocommit-job",
          deviceId: null,
        },
      });

      if (out?.committed) {
        logger.info({ height: out.height, itemsCount: out.itemsCount }, "audit_ledger_autocommit_committed");
      }
    } catch (err) {
      const status = Number(err?.status || 0);
      if (status === 409) return;
      logger.error({ err }, "audit_ledger_autocommit_failed");
    }
  }, intervalMs);
}

module.exports = { startAuditLedgerAutoCommitJob };
