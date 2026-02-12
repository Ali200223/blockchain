// server/src/jobs/reconcilePointers.job.js
const { pool } = require("../config/mysql");
const { logger } = require("../config/logger");

let cached = null;
let warnedDisabled = false;

async function getColumns(tableName) {
  const [rows] = await pool.query(
    `
    SELECT COLUMN_NAME
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
    `,
    [tableName]
  );
  return new Set(rows.map((r) => r.COLUMN_NAME));
}

function pickFirstExisting(cols, candidates) {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

/**
 * Build mappings from wallet_transactions -> trade_fills using semantic candidates.
 * We alias wallet src columns to trade dst column names in SELECT to simplify UPDATE.
 */
async function loadSchema() {
  if (cached) return cached;

  const walletCols = await getColumns("wallet_transactions");
  const tradeCols = await getColumns("trade_fills");

  // Common pointer field name candidates (in priority order)
  const heightTrade = pickFirstExisting(tradeCols, ["ledger_block_height"]);
  const heightWallet = pickFirstExisting(walletCols, ["ledger_block_height"]);

  const blockHashTrade = pickFirstExisting(tradeCols, ["ledger_block_hash"]);
  const blockHashWallet = pickFirstExisting(walletCols, ["ledger_block_hash"]);

  // "Item hash" might be stored under different names
  const itemHashTrade = pickFirstExisting(tradeCols, ["ledger_item_hash", "ledger_leaf_hash"]);
  const itemHashWallet = pickFirstExisting(walletCols, ["ledger_item_hash", "ledger_leaf_hash"]);

  // Support both spellings
  const itemIndexTrade = pickFirstExisting(tradeCols, ["ledger_item_idx", "ledger_item_index"]);
  const itemIndexWallet = pickFirstExisting(walletCols, ["ledger_item_idx", "ledger_item_index"]);

  const itemIdTrade = pickFirstExisting(tradeCols, ["ledger_item_id"]);
  const itemIdWallet = pickFirstExisting(walletCols, ["ledger_item_id"]);

  // Commit pointers (often present even when block hash isn't)
  const commitKeyTrade = pickFirstExisting(tradeCols, ["ledger_commit_key"]);
  const commitKeyWallet = pickFirstExisting(walletCols, ["ledger_commit_key"]);

  const committedAtTrade = pickFirstExisting(tradeCols, ["ledger_committed_at"]);
  const committedAtWallet = pickFirstExisting(walletCols, ["ledger_committed_at"]);

  // Build src->dst mappings (allow different names, e.g. wallet ledger_leaf_hash -> trade ledger_item_hash)
  const mappings = [];
  if (heightTrade && heightWallet) mappings.push({ src: heightWallet, dst: heightTrade });
  if (blockHashTrade && blockHashWallet) mappings.push({ src: blockHashWallet, dst: blockHashTrade });

  if (itemHashTrade && itemHashWallet) mappings.push({ src: itemHashWallet, dst: itemHashTrade });
  if (itemIndexTrade && itemIndexWallet) mappings.push({ src: itemIndexWallet, dst: itemIndexTrade });
  if (itemIdTrade && itemIdWallet) mappings.push({ src: itemIdWallet, dst: itemIdTrade });

  if (commitKeyTrade && commitKeyWallet) mappings.push({ src: commitKeyWallet, dst: commitKeyTrade });
  if (committedAtTrade && committedAtWallet) mappings.push({ src: committedAtWallet, dst: committedAtTrade });

  // Enable if we can copy block height AND at least one "item pointer" or commit pointer.
  const enabled =
    mappings.some((m) => m.dst === heightTrade) &&
    (mappings.some((m) => m.dst === itemIndexTrade) ||
      mappings.some((m) => m.dst === itemHashTrade) ||
      mappings.some((m) => m.dst === itemIdTrade) ||
      mappings.some((m) => m.dst === commitKeyTrade));

  cached = {
    enabled,
    mappings,
    walletCols: Array.from(walletCols),
    tradeCols: Array.from(tradeCols),
    // For "missing wallet pointers" detection we check the wallet-side sources we actually use:
    walletCheckFields: mappings
      .map((m) => m.src)
      .filter((v, i, a) => a.indexOf(v) === i),
    // For trade missing detection:
    tradeCheckFields: mappings
      .map((m) => m.dst)
      .filter((v, i, a) => a.indexOf(v) === i),
  };

  return cached;
}

async function reconcilePointersOnce({ batchSize = 200 } = {}) {
  const schema = await loadSchema();

  if (!schema.enabled) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      logger.warn(
        {
          walletCols: schema.walletCols,
          tradeCols: schema.tradeCols,
          mappings: schema.mappings,
        },
        "reconcile_job_disabled_missing_required_pointer_columns"
      );
    }
    return { relinked: 0, missingWallet: 0, disabled: true };
  }

  const { mappings, walletCheckFields, tradeCheckFields } = schema;

  // SELECT fields: alias wallet src -> trade dst name
  const selectFields = mappings
    .map((m) => `wt.\`${m.src}\` AS \`${m.dst}\``)
    .join(",\n      ");

  const tfMissingCond = tradeCheckFields.map((c) => `tf.\`${c}\` IS NULL`).join(" OR ");
  const wtPresentCond = walletCheckFields.map((c) => `wt.\`${c}\` IS NOT NULL`).join(" AND ");

  const sql = `
    SELECT
      tf.id AS trade_fill_id,
      wt.id AS wallet_tx_id,
      ${selectFields}
    FROM trade_fills tf
    JOIN wallet_transactions wt
      ON wt.reference_id = tf.reference_id
    WHERE tf.status <> 'REVERSED'
      AND (${tfMissingCond})
      AND (${wtPresentCond})
    ORDER BY tf.id ASC
    LIMIT ?
  `;

  const [rows] = await pool.query(sql, [batchSize]);

  let relinked = 0;

  for (const r of rows) {
    // UPDATE trade_fills set dst columns = aliased values
    const setClause = tradeCheckFields.map((c) => `\`${c}\` = ?`).join(", ");
    const whereMissing = tradeCheckFields.map((c) => `\`${c}\` IS NULL`).join(" OR ");

    const params = tradeCheckFields.map((c) => r[c]).concat([r.trade_fill_id]);

    const [upd] = await pool.query(
      `
      UPDATE trade_fills
         SET ${setClause}
       WHERE id = ?
         AND (${whereMissing})
      `,
      params
    );

    relinked += upd.affectedRows || 0;
  }

  // Detect wallet tx missing pointers (based on wallet fields we actually use)
  const walletMissingCond = walletCheckFields.map((c) => `\`${c}\` IS NULL`).join(" OR ");

  const [missingWalletRows] = await pool.query(
    `
    SELECT id, user_id, type, reference_id, created_at
      FROM wallet_transactions
     WHERE status = 'CONFIRMED'
       AND (${walletMissingCond})
     ORDER BY id ASC
     LIMIT ?
    `,
    [batchSize]
  );

  if (missingWalletRows.length > 0) {
    logger.warn(
      { count: missingWalletRows.length, sample: missingWalletRows.slice(0, 3) },
      "reconcile_wallet_missing_ledger_pointers"
    );
  }

  return { relinked, missingWallet: missingWalletRows.length, disabled: false };
}

function startReconcilePointersJob() {
  const enabled = String(process.env.RECONCILE_JOB_ENABLED || "true").toLowerCase() === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.RECONCILE_JOB_INTERVAL_MS || "60000");
  const batchSize = Number(process.env.RECONCILE_JOB_BATCH || "200");

  logger.info({ intervalMs, batchSize }, "reconcile_job_started");

  setInterval(async () => {
    try {
      const r = await reconcilePointersOnce({ batchSize });
      if (r.relinked || r.missingWallet) logger.info(r, "reconcile_job_tick");
    } catch (err) {
      logger.error({ err }, "reconcile_job_failed");
    }
  }, intervalMs);
}

module.exports = { startReconcilePointersJob, reconcilePointersOnce };
