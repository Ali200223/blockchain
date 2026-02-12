// core_files/jobs/tradeResync.job.js
const mongoose = require("mongoose");
const Trade = require("../models/trade");
const Order = require("../models/order");
const SyncState = require("../models/syncState");
const { listFillsInternal } = require("../services/personA.gateway");

const DEFAULT_INTERVAL_MS = Number(process.env.TRADE_RESYNC_INTERVAL_MS || "120000"); // 2 min
const DEFAULT_LIMIT = Math.max(50, Math.min(500, Number(process.env.TRADE_RESYNC_LIMIT || "200")));

const ENABLE_BACKFILL = String(process.env.TRADE_RESYNC_BACKFILL || "false").toLowerCase() === "true";
const BACKFILL_PAGES_PER_RUN = Math.max(1, Math.min(10, Number(process.env.TRADE_RESYNC_BACKFILL_PAGES || "2"))); // limit workload

function uniq(arr) {
  return Array.from(new Set(arr.filter(Boolean)));
}

function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function mapFillRowToTradeDoc(userId, row) {
  return {
    userId,
    referenceId: String(row.reference_id),

    fillId: Number(row.id),

    walletTxId: row.wallet_tx_id != null ? Number(row.wallet_tx_id) : null,

    symbol: String(row.symbol || "").toUpperCase(),
    side: String(row.side || "").toUpperCase(),

    qty: String(row.qty),
    price: String(row.price),

    grossQuote: row.gross_quote != null ? String(row.gross_quote) : null,
    feeQuote: row.fee_quote != null ? String(row.fee_quote) : null,
    netQuote: row.net_quote != null ? String(row.net_quote) : null,

    status: row.status != null ? String(row.status) : "FILLED",
    executedAt: toDate(row.created_at) || new Date(),

    ledgerBlockHeight: row.ledger_block_height != null ? Number(row.ledger_block_height) : null,
    ledgerItemIdx: row.ledger_item_idx != null ? Number(row.ledger_item_idx) : null,
    ledgerCommitKey: row.ledger_commit_key != null ? String(row.ledger_commit_key) : null,
    ledgerCommittedAt: toDate(row.ledger_committed_at),

    //source: "ORDER_EXECUTOR",
  };
}


async function getKnownUserIds() {
  const [tradeUsers, orderUsers] = await Promise.all([
    Trade.distinct("userId"),
    Order.distinct("userId"),
  ]);
  return uniq([...tradeUsers, ...orderUsers]);
}

async function upsertTradesForUser({ userId, rows }) {
  if (!rows?.length) return { upserted: 0 };

  let upserted = 0;

  // Upsert one-by-one (simple + safe).
  // If you want higher throughput later, switch to bulkWrite.
  for (const r of rows) {
    if (!r?.reference_id) continue;

    const doc = mapFillRowToTradeDoc(userId, r);

   await Trade.updateOne(
  { referenceId: doc.referenceId, userId: doc.userId },
  {
    $set: {
      // fields that should always be corrected/backfilled
      walletTxId: doc.walletTxId,
      ledgerBlockHeight: doc.ledgerBlockHeight,
      ledgerItemIdx: doc.ledgerItemIdx,
      ledgerCommitKey: doc.ledgerCommitKey,
      ledgerCommittedAt: doc.ledgerCommittedAt,
      status: doc.status,
      price: doc.price,
      qty: doc.qty,
      grossQuote: doc.grossQuote,
      feeQuote: doc.feeQuote,
      netQuote: doc.netQuote,
      executedAt: doc.executedAt,
      source: doc.source,
      symbol: doc.symbol,
      side: doc.side,
      fillId: doc.fillId,
    },
    $setOnInsert: {
      // stable identifiers
      referenceId: doc.referenceId,
      userId: doc.userId,
      orderId: doc.orderId ?? null,
    },
  },
  { upsert: true }
);

    upserted += 1;
  }

  return { upserted };
}

async function syncUserLatest({ userId, limit }) {
  const resp = await listFillsInternal({ userId, limit });
  if (!resp?.ok) throw new Error(`PersonA listFillsInternal not ok for userId=${userId}`);

  const rows = resp.rows || [];
  const { upserted } = await upsertTradesForUser({ userId, rows });

  // rows are newest first; nextCursorId is the last row's id (smallest in this page)
  const nextCursorId = resp.nextCursorId ?? (rows.length ? rows[rows.length - 1].id : null);

  return { upserted, nextCursorId, rowCount: rows.length };
}

async function backfillUser({ userId, limit }) {
  const state = await SyncState.findOne({ userId }).lean();
  let cursorId = state?.backfillCursorId ?? null;

  let totalUpserted = 0;
  let pages = 0;

  while (pages < BACKFILL_PAGES_PER_RUN) {
    const resp = await listFillsInternal({ userId, limit, cursorId });
    if (!resp?.ok) throw new Error(`PersonA backfill list not ok for userId=${userId}`);

    const rows = resp.rows || [];
    if (!rows.length) break;

    const { upserted } = await upsertTradesForUser({ userId, rows });
    totalUpserted += upserted;

    cursorId = resp.nextCursorId ?? rows[rows.length - 1].id;
    pages += 1;

    // If nextCursorId is null, we reached the end.
    if (!cursorId) break;
  }

  await SyncState.updateOne(
    { userId },
    { $set: { backfillCursorId: cursorId, lastRunAt: new Date(), lastError: null } },
    { upsert: true }
  );

  return { totalUpserted, pages, cursorId };
}

async function runOnce() {
  // wait for Mongo connection
  if (mongoose.connection.readyState !== 1) return;

  const userIds = await getKnownUserIds();
  if (!userIds.length) return;

  for (const userId of userIds) {
    try {
      // Always sync latest first (repairs “recent missing projection”)
      const latest = await syncUserLatest({ userId, limit: DEFAULT_LIMIT });

      // Update sync state (non-backfill fields)
      await SyncState.updateOne(
        { userId },
        { $set: { lastRunAt: new Date(), lastError: null } },
        { upsert: true }
      );

      // Optional: backfill deeper history incrementally
      if (ENABLE_BACKFILL && latest.nextCursorId) {
        // Initialize backfill cursor if not set yet
        const s = await SyncState.findOne({ userId }).lean();
        if (!s?.backfillCursorId) {
          await SyncState.updateOne(
            { userId },
            { $set: { backfillCursorId: latest.nextCursorId } },
            { upsert: true }
          );
        }
        await backfillUser({ userId, limit: DEFAULT_LIMIT });
      }
    } catch (e) {
      await SyncState.updateOne(
        { userId },
        { $set: { lastRunAt: new Date(), lastError: String(e?.message || e) } },
        { upsert: true }
      );
    }
  }
}

function startTradeResyncJob({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  // kick once after short delay so server can boot
  setTimeout(() => {
    runOnce().catch(() => {});
  }, 5000);

  setInterval(() => {
    runOnce().catch(() => {});
  }, intervalMs);

  console.log(`🟣 Trade resync job started (interval=${intervalMs}ms, limit=${DEFAULT_LIMIT}, backfill=${ENABLE_BACKFILL})`);
}

module.exports = { startTradeResyncJob };
