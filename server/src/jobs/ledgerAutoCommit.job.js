// server/src/jobs/ledgerAutoCommit.job.js
const { logger } = require("../config/logger");
const ledgerService = require("../modules/ledger/ledger.service");

function startLedgerAutoCommitJob() {
  const enabled = String(process.env.LEDGER_AUTOCOMMIT_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.LEDGER_AUTOCOMMIT_INTERVAL_MS || "5000");
  const maxItems = Number(process.env.LEDGER_AUTOCOMMIT_MAX_ITEMS || "500");
  const systemUserId = String(process.env.SYSTEM_LEDGER_USER_ID || "SYSTEM");

  logger.info({ intervalMs, maxItems }, "ledger_autocommit_job_started");

  setInterval(async () => {
    try {
      const out = await ledgerService.commitNextBlock({
        sealedByUserId: systemUserId,
        maxItems,
        meta: {
          requestId: "job:ledger_autocommit",
          adminUserId: systemUserId,
          ip: null,
          userAgent: "ledger-autocommit-job",
          deviceId: null,
        },
      });

      if (out?.committed) {
        logger.info({ height: out.height, itemsCount: out.itemsCount }, "ledger_autocommit_committed");
      }
    } catch (err) {
      // Expected contention cases: commit already in progress or conflict
      const status = Number(err?.status || 0);
      if (status === 409) return;
      logger.error({ err }, "ledger_autocommit_failed");
    }
  }, intervalMs);
}

module.exports = { startLedgerAutoCommitJob };
