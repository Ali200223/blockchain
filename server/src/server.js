const { env } = require("./config/env");
const { logger } = require("./config/logger");
const { app } = require("./app");
const { pool } = require("./config/mysql");
const { connectMongo, closeMongo } = require("./config/mongo");

const { startReconcilePointersJob } = require("./jobs/reconcilePointers.job");
const { startWeeklyMlTrainingJob } = require("./jobs/weeklyMlTraining.job");
const { startLedgerAutoCommitJob } = require("./jobs/ledgerAutoCommit.job");
const { startAuditLedgerAutoCommitJob } = require("./jobs/auditLedgerAutoCommit.job");






let httpServer = null;

async function shutdown(signal) {
  try {
    logger.warn({ signal }, "shutdown_started");

    if (httpServer) {
      await new Promise((resolve) => httpServer.close(resolve));
      httpServer = null;
    }

    // Close Mongo
    await closeMongo().catch((e) => logger.warn({ err: e }, "mongo_close_failed"));

    // Close MySQL pool
    await pool.end().catch((e) => logger.warn({ err: e }, "mysql_pool_end_failed"));

    logger.warn({ signal }, "shutdown_complete");
    process.exit(0);
  } catch (e) {
    logger.error({ err: e }, "shutdown_failed");
    process.exit(1);
  }
}

async function main() {
  // verify DB connectivity on boot (industrial practice)
  await pool.query("SELECT 1");

  // ensure Mongo is connected + indexes created
  await connectMongo();



  startReconcilePointersJob();
  startWeeklyMlTrainingJob();
  startLedgerAutoCommitJob();
  startAuditLedgerAutoCommitJob();




  httpServer = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, "server_started");
  });

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.fatal({ err }, "server_failed_to_start");
  process.exit(1);
});
