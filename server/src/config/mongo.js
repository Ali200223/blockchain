// server/src/config/mongo.js
const { MongoClient } = require("mongodb");
const { env } = require("./env");
const { logger } = require("./logger");

let client = null;
let db = null;
let connecting = null;

function stableJson(x) {
  try {
    const keys = x && typeof x === "object" ? Object.keys(x).sort() : [];
    return JSON.stringify(x, keys);
  } catch {
    return String(x);
  }
}

function sameIndex(existing, desired) {
  const a = existing || {};
  const b = desired || {};

  const sameKey = stableJson(a.key) === stableJson(b.key);
  const sameUnique = Boolean(a.unique) === Boolean(b.unique);
  const sameExpire = (a.expireAfterSeconds ?? null) === (b.expireAfterSeconds ?? null);
  const samePartial =
    stableJson(a.partialFilterExpression || null) === stableJson(b.partialFilterExpression || null);

  return sameKey && sameUnique && sameExpire && samePartial;
}

async function ensureIndex(col, keys, options) {
  const name = options?.name;
  if (!name) throw new Error("ensureIndex requires an explicit { name }");

  const desired = { key: keys, ...options, name };

  let indexes = [];
  try {
    indexes = await col.indexes();
  } catch {
    indexes = [];
  }

  const byName = indexes.find((i) => i.name === name) || null;
  if (byName) {
    if (sameIndex(byName, desired)) return;

    logger.warn(
      { collection: col.collectionName, want: name, have: byName.name, existing: byName, desired },
      "mongo_index_mismatch_dropping"
    );

    await col.dropIndex(byName.name);
    await col.createIndex(keys, options);
    return;
  }

  const sameKeyIdx = indexes.find((i) => stableJson(i.key) === stableJson(keys)) || null;

  if (sameKeyIdx && !sameIndex(sameKeyIdx, desired)) {
    logger.warn(
      { collection: col.collectionName, drop: sameKeyIdx.name, existing: sameKeyIdx, desired },
      "mongo_index_same_key_different_options_dropping"
    );

    await col.dropIndex(sameKeyIdx.name);
    await col.createIndex(keys, options);
    return;
  }

  const equivalent = indexes.find((i) => sameIndex(i, desired)) || null;
  if (equivalent) {
    logger.info(
      { collection: col.collectionName, want: name, have: equivalent.name, keys },
      "mongo_index_equivalent_exists_reusing"
    );
    return;
  }

  try {
    await col.createIndex(keys, options);
  } catch (e) {
    const msg = String(e?.message || "");

    const looksLikeConflict =
      msg.includes("already exists with a different name") ||
      msg.includes("IndexOptionsConflict") ||
      msg.includes("IndexKeySpecsConflict") ||
      msg.includes("same name") ||
      msg.includes("conflicts");

    if (!looksLikeConflict) throw e;

    const idx2 = await col.indexes();

    const byName2 = idx2.find((i) => i.name === name) || null;
    if (byName2) {
      if (sameIndex(byName2, desired)) return;
      await col.dropIndex(byName2.name);
      await col.createIndex(keys, options);
      return;
    }

    const sameKey2 = idx2.find((i) => stableJson(i.key) === stableJson(keys)) || null;
    if (sameKey2 && !sameIndex(sameKey2, desired)) {
      await col.dropIndex(sameKey2.name);
      await col.createIndex(keys, options);
      return;
    }

    const eq2 = idx2.find((i) => sameIndex(i, desired)) || null;
    if (eq2) {
      logger.info(
        { collection: col.collectionName, want: name, have: eq2.name, keys },
        "mongo_index_equivalent_exists_reusing_after_conflict"
      );
      return;
    }

    await col.createIndex(keys, options);
  }
}

async function ensureIndexes(mongoDb) {
  // =========================
  // Ledger (Week 4)
  // =========================
  const blocks = mongoDb.collection("ledger_blocks");
  const items = mongoDb.collection("ledger_items");
  const locks = mongoDb.collection("ledger_locks");
  const actions = mongoDb.collection("ledger_admin_actions");

  await ensureIndex(blocks, { height: 1 }, { unique: true, name: "uq_ledger_blocks_height" });
  await ensureIndex(blocks, { blockHash: 1 }, { unique: true, name: "uq_ledger_blocks_blockHash" });
  await ensureIndex(blocks, { commitKey: 1 }, { unique: true, name: "uq_ledger_blocks_commitKey" });
  await ensureIndex(blocks, { createdAt: -1 }, { name: "ix_ledger_blocks_createdAt_desc" });

  await ensureIndex(items, { blockId: 1, idx: 1 }, { unique: true, name: "uq_ledger_items_blockId_idx" });
  await ensureIndex(items, { source: 1, sourceId: 1 }, { unique: true, name: "uq_ledger_items_source_sourceId" });
  await ensureIndex(items, { blockHeight: 1, idx: 1 }, { name: "ix_ledger_items_blockHeight_idx" });
  await ensureIndex(items, { createdAt: 1 }, { name: "ix_ledger_items_createdAt" });

  // Locks: support stale cleanup + diagnostics
  await ensureIndex(locks, { updatedAt: 1 }, { name: "ix_ledger_locks_updatedAt" });
  await ensureIndex(locks, { expiresAt: 1 }, { name: "ix_ledger_locks_expiresAt" });
  await ensureIndex(locks, { owner: 1 }, { name: "ix_ledger_locks_owner" });

  // Admin actions: audit + idempotency
  await ensureIndex(actions, { createdAt: -1 }, { name: "ix_ledger_admin_actions_createdAt_desc" });
  await ensureIndex(actions, { adminUserId: 1, createdAt: -1 }, { name: "ix_ledger_admin_actions_admin_createdAt" });
  await ensureIndex(
    actions,
    { idempotencyKey: 1 },
    {
      unique: true,
      name: "uq_ledger_admin_actions_idempotencyKey",
      partialFilterExpression: { idempotencyKey: { $exists: true, $type: "string" } },
    }
  );
  await ensureIndex(actions, { action: 1, status: 1, createdAt: -1 }, { name: "ix_ledger_admin_actions_action_status_createdAt" });

  
  // =========================
  // Audit Ledger (Security)
  // =========================
  const aBlocks = mongoDb.collection("audit_blocks");
  const aItems = mongoDb.collection("audit_items");
  const aLocks = mongoDb.collection("audit_locks");
  const aActions = mongoDb.collection("audit_admin_actions");

  await ensureIndex(aBlocks, { height: 1 }, { unique: true, name: "uq_audit_blocks_height" });
  await ensureIndex(aBlocks, { blockHash: 1 }, { unique: true, name: "uq_audit_blocks_blockHash" });
  await ensureIndex(aBlocks, { commitKey: 1 }, { unique: true, name: "uq_audit_blocks_commitKey" });
  await ensureIndex(aBlocks, { createdAt: -1 }, { name: "ix_audit_blocks_createdAt_desc" });

  await ensureIndex(aItems, { blockId: 1, idx: 1 }, { unique: true, name: "uq_audit_items_blockId_idx" });
  await ensureIndex(aItems, { source: 1, sourceId: 1 }, { unique: true, name: "uq_audit_items_source_sourceId" });
  await ensureIndex(aItems, { blockHeight: 1, idx: 1 }, { name: "ix_audit_items_blockHeight_idx" });
  await ensureIndex(aItems, { createdAt: 1 }, { name: "ix_audit_items_createdAt" });

  await ensureIndex(aLocks, { updatedAt: 1 }, { name: "ix_audit_locks_updatedAt" });
  await ensureIndex(aLocks, { expiresAt: 1 }, { name: "ix_audit_locks_expiresAt" });
  await ensureIndex(aLocks, { owner: 1 }, { name: "ix_audit_locks_owner" });

  await ensureIndex(aActions, { createdAt: -1 }, { name: "ix_audit_admin_actions_createdAt_desc" });
  await ensureIndex(aActions, { adminUserId: 1, createdAt: -1 }, { name: "ix_audit_admin_actions_admin_createdAt" });
  await ensureIndex(
    aActions,
    { idempotencyKey: 1 },
    {
      unique: true,
      name: "uq_audit_admin_actions_idempotencyKey",
      partialFilterExpression: { idempotencyKey: { $exists: true, $type: "string" } },
    }
  );
  await ensureIndex(aActions, { action: 1, status: 1, createdAt: -1 }, { name: "ix_audit_admin_actions_action_status_createdAt" });


// =========================
  // Alerts Engine (Week 4)
  // =========================
  const alerts = mongoDb.collection("alerts");

  await ensureIndex(alerts, { userId: 1, createdAt: -1 }, { name: "ix_alerts_userId_createdAt" });
  await ensureIndex(
  alerts,
  { userId: 1, status: 1, score: -1, createdAt: -1 },
  { name: "ix_alerts_userId_status_score_createdAt" }
);


  await ensureIndex(
    alerts,
    { userId: 1, dedupeKey: 1, bucket: 1 },
    {
      unique: true,
      name: "uq_alerts_dedupe_bucket",
      partialFilterExpression: {
        dedupeKey: { $exists: true, $type: "string" },
        bucket: { $exists: true, $type: "string" },
      },
    }
  );

  const sec = mongoDb.collection("signals_security");
  const ml = mongoDb.collection("signals_ml");

  await ensureIndex(sec, { userId: 1, createdAt: -1 }, { name: "ix_signals_security_userId_createdAt" });
  await ensureIndex(ml, { userId: 1, createdAt: -1 }, { name: "ix_signals_ml_userId_createdAt" });

  await ensureIndex(sec, { createdAt: 1 }, { name: "ttl_signals_security_30d", expireAfterSeconds: 60 * 60 * 24 * 30 });
  await ensureIndex(ml, { createdAt: 1 }, { name: "ttl_signals_ml_30d", expireAfterSeconds: 60 * 60 * 24 * 30 });

  const preds = mongoDb.collection("ml_predictions");

  
  await ensureIndex(preds, { userId: 1, createdAt: -1 }, { name: "ix_ml_predictions_userId_createdAt" });

  
  await ensureIndex(preds, { createdAt: -1 }, { name: "ix_ml_predictions_createdAt_desc" });

  
  await ensureIndex(
    preds,
    { requestId: 1 },
    {
      unique: true,
      name: "uq_ml_predictions_requestId",
      partialFilterExpression: { requestId: { $exists: true, $type: "string" } },
    }
  );

  
  await ensureIndex(
    preds,
    { "model.name": 1, "model.version": 1, createdAt: -1 },
    { name: "ix_ml_predictions_model_createdAt" }
  );

}

async function connectMongo() {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    client = new MongoClient(env.MONGO_URI, {
      maxPoolSize: Number(env.MONGO_MAX_POOL_SIZE),
      minPoolSize: Number(env.MONGO_MIN_POOL_SIZE),
      serverSelectionTimeoutMS: Number(env.MONGO_SERVER_SELECTION_TIMEOUT_MS),
      connectTimeoutMS: Number(env.MONGO_CONNECT_TIMEOUT_MS),
      retryWrites: true,
    });

    await client.connect();
    db = client.db(env.MONGO_DB);

    await ensureIndexes(db);

    logger.info({ mongoDb: db.databaseName }, "mongo_connected");
    return db;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function getMongoDb() {
  if (!db) {
    const err = new Error("MongoDB not connected");
    err.status = 500;
    throw err;
  }
  return db;
}

async function closeMongo() {
  if (client) {
    await client.close();
  }
  client = null;
  db = null;
}

module.exports = { connectMongo, getMongoDb, closeMongo };
