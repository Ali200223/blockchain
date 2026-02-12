const crypto = require("crypto");
const { pool } = require("../../config/mysql");
const { getMongoDb } = require("../../config/mongo");
const { logger } = require("../../config/logger");

const LOCK_KEY_COMMIT_NEXT = "ledger_commit_next_block";
const LOCK_KEY_COMMIT_NEXT_AUDIT = "audit_commit_next_block";

const COLS = {
  settlement: {
    blocks: "ledger_blocks",
    items: "ledger_items",
    cursors: "ledger_cursors",
    locks: "ledger_locks",
    actions: "ledger_admin_actions",
  },
  audit: {
    blocks: "audit_blocks",
    items: "audit_items",
    cursors: "audit_cursors",
    locks: "audit_locks",
    actions: "audit_admin_actions",
  },
};

function sha256Hex(input) {
  return crypto.createHash("sha256").update(String(input)).digest("hex");
}

function genOwner() {
  if (typeof crypto.randomUUID === "function") return `srv:${crypto.randomUUID()}`;
  return `srv:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
}

function canonicalize(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = canonicalize(value[k]);
    return out;
  }
  return value;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function merkleRootHex(leafHashes) {
  if (!leafHashes.length) return sha256Hex("EMPTY_BLOCK");

  let level = leafHashes.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return level[0];
}

function buildMerkleProof(leafHashes, leafIndex) {
  const n = leafHashes.length;
  const idx0 = Number(leafIndex);

  if (!Number.isFinite(idx0) || idx0 < 0 || idx0 >= n) {
    const err = new Error("Invalid leaf index");
    err.status = 400;
    throw err;
  }

  let index = idx0;
  let level = leafHashes.slice();
  const proof = [];

  while (level.length > 1) {
    const isRight = index % 2 === 1;
    const siblingIndex = isRight ? index - 1 : index + 1;
    const siblingHash = level[siblingIndex] ?? level[index]; // duplicate if odd

    proof.push({
      position: isRight ? "LEFT" : "RIGHT", // how sibling combines with current
      hash: siblingHash,
    });

    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? level[i];
      next.push(sha256Hex(left + right));
    }

    level = next;
    index = Math.floor(index / 2);
  }

  return {
    leafIndex: idx0,
    leafHash: leafHashes[idx0],
    merkleRoot: level[0],
    proof,
  };
}

function verifyMerkleProof({ leafHash, proof, merkleRoot } = {}) {
  let h = String(leafHash || "");
  for (const step of proof || []) {
    const sib = String(step?.hash || "");
    if (step?.position === "LEFT") h = sha256Hex(sib + h);
    else h = sha256Hex(h + sib);
  }
  return h === String(merkleRoot || "");
}


function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function toIsoMaybe(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(v);
}

function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

async function getTipBlock(db, blocksCol = COLS.settlement.blocks) {
  return db.collection(blocksCol).findOne({}, { sort: { height: -1 } });
}

async function getCursor(db, source, cursorsCol = COLS.settlement.cursors) {
  const doc = await db.collection(cursorsCol).findOne({ _id: source });
  if (!doc) return 0;
  const n = Number(doc.lastId);
  return Number.isFinite(n) ? n : 0;
}

async function setCursor(db, source, lastId, cursorsCol = COLS.settlement.cursors) {
  await db.collection(cursorsCol).updateOne(
    { _id: source },
    { $set: { lastId: Number(lastId), updatedAt: new Date() } },
    { upsert: true }
  );
}

async function fetchSecurityLogs(afterId, limit) {
  const [rows] = await pool.query(
    `
      SELECT id, user_id, event_type, ip, user_agent, metadata, created_at
      FROM security_logs
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `,
    [Number(afterId), Number(limit)]
  );
  return rows;
}

async function fetchWalletTransactions(afterId, limit) {
  const [rows] = await pool.query(
    `
      SELECT id, user_id, type, amount, balance_after, description, reference_id, status, created_at
      FROM wallet_transactions
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `,
    [Number(afterId), Number(limit)]
  );
  return rows;
}
function chunkArray(arr, size) {
  const out = [];
  const n = Math.max(1, Number(size) || 1);
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}


async function fetchTradeFills(afterId, limit) {
  const [rows] = await pool.query(
    `
      SELECT
        id, user_id, side, symbol, qty, price,
        gross_quote, fee_quote, net_quote,
        wallet_tx_id, reference_id, request_id, status, created_at
      FROM trade_fills
      WHERE id > ?
      ORDER BY id ASC
      LIMIT ?
    `,
    [Number(afterId), Number(limit)]
  );
  return rows;
}


async function updateMySqlLedgerPointers({
  height,
  blockHash,
  commitKey,
  committedAt,
  walletPairs = [],
  securityPairs = [],
  tradePairs = [],
} = {}) {

  const h = Number(height);
  if (!Number.isFinite(h) || h < 1) return;

  const safeBlockHash = String(blockHash || "");
  const safeCommitKey = String(commitKey || "");
  const when = committedAt instanceof Date ? committedAt : new Date(committedAt || Date.now());

  async function updateTable(table, pairs) {
    if (!pairs.length) return;

    const rows = pairs
      .map((p) => ({ id: Number(p.id), idx: Number(p.idx) }))
      .filter((p) => Number.isFinite(p.id) && Number.isFinite(p.idx));

    if (!rows.length) return;

    for (const chunk of chunkArray(rows, 200)) {
      const ids = chunk.map((x) => x.id);
      const whens = chunk.map((x) => `WHEN ${x.id} THEN ${x.idx}`).join(" ");
      const inList = ids.map(() => "?").join(",");

      const sql = `
        UPDATE ${table}
        SET
          ledger_block_height = ?,
          ledger_block_hash   = ?,
          ledger_commit_key   = ?,
          ledger_item_idx     = CASE id ${whens} END,
          ledger_committed_at = ?
        WHERE id IN (${inList})
          AND ledger_block_height IS NULL
      `;

      const params = [h, safeBlockHash, safeCommitKey, when, ...ids];
      await pool.query(sql, params);
    }
  }

  await updateTable("wallet_transactions", walletPairs);
  await updateTable("security_logs", securityPairs);
  await updateTable("trade_fills", tradePairs);

}

function normalizeItem(source, row) {
  const createdAt = toIsoMaybe(row.created_at);

  let payload;

  if (source === "security_logs") {
    payload = {
      id: Number(row.id),
      userId: row.user_id,
      eventType: row.event_type,
      ip: row.ip,
      userAgent: row.user_agent,
      metadata: row.metadata ?? null,
      createdAt,
    };
  } else if (source === "wallet_transactions") {
    payload = {
      id: Number(row.id),
      userId: row.user_id,
      type: row.type,
      amount: String(row.amount),
      balanceAfter: String(row.balance_after),
      description: row.description,
      referenceId: row.reference_id ?? null,
      status: row.status,
      createdAt,
    };
  } else if (source === "trade_fills") {
    payload = {
      id: Number(row.id),
      userId: row.user_id,
      side: row.side,
      symbol: row.symbol,
      qty: String(row.qty),
      price: String(row.price),
      grossQuote: String(row.gross_quote),
      feeQuote: String(row.fee_quote),
      netQuote: String(row.net_quote),
      walletTxId: row.wallet_tx_id == null ? null : Number(row.wallet_tx_id),
      referenceId: row.reference_id ?? null,
      requestId: row.request_id ?? null,
      status: row.status,
      createdAt,
    };
  } else {
    const err = new Error(`Unknown ledger source: ${source}`);
    err.status = 500;
    throw err;
  }

  const payloadHash = sha256Hex(canonicalStringify({ source, payload }));

  return {
    source,
    sourceId: Number(row.id),
    createdAt,
    payload,
    payloadHash,
  };
}


function lockConfig() {
  const ttlMsRaw = envInt("LEDGER_LOCK_TTL_MS", 30000);
  const maxTtlMs = envInt("LEDGER_LOCK_MAX_TTL_MS", 60000);
  const ttlMs = clamp(ttlMsRaw, 1000, maxTtlMs);

  const staleMsRaw = envInt("LEDGER_LOCK_STALE_MS", Math.max(60000, ttlMs * 2));
  const staleMs = Math.max(ttlMs * 2, staleMsRaw);

  const invalidFutureMs = envInt("LEDGER_LOCK_INVALID_FUTURE_MS", maxTtlMs * 2);

  return { ttlMs, staleMs, invalidFutureMs };
}

async function getLockInfo(db, key, locksCol = COLS.settlement.locks) {
  const doc = await db.collection(locksCol).findOne({ _id: key });
  if (!doc) return null;
  return {
    key: doc._id,
    owner: doc.owner ?? null,
    expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : doc.expiresAt ?? null,
    updatedAt: doc.updatedAt instanceof Date ? doc.updatedAt.toISOString() : doc.updatedAt ?? null,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : doc.createdAt ?? null,
  };
}

/**
 * Driver-safe distributed lock acquisition.
 * - Uses returnDocument + returnOriginal fallback
 * - If res.value is null (some driver paths on upsert), falls back to a read
 */
async function acquireDistributedLock(db, key, owner, locksCol = COLS.settlement.locks) {
  const { ttlMs, staleMs, invalidFutureMs } = lockConfig();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const staleAt = new Date(now.getTime() - staleMs);
  const invalidFutureAt = new Date(now.getTime() + invalidFutureMs);

  const nonDateTypes = [
    "double",
    "string",
    "object",
    "array",
    "binData",
    "objectId",
    "bool",
    "null",
    "regex",
    "dbPointer",
    "javascript",
    "symbol",
    "javascriptWithScope",
    "int",
    "timestamp",
    "long",
    "decimal",
    "minKey",
    "maxKey",
  ];

  const filter = {
    _id: key,
    $or: [
      { owner }, // re-entrant
      { expiresAt: { $exists: false } },
      { $and: [{ expiresAt: { $type: "date" } }, { expiresAt: { $lte: now } }] },
      { expiresAt: { $type: nonDateTypes } },
      { updatedAt: { $exists: false } },
      { $and: [{ updatedAt: { $type: "date" } }, { updatedAt: { $lte: staleAt } }] },
      { $and: [{ expiresAt: { $type: "date" } }, { expiresAt: { $gt: invalidFutureAt } }] },
    ],
  };

  const locks = db.collection(locksCol);

  const res = await locks.findOneAndUpdate(
    filter,
    {
      $set: { owner, expiresAt, updatedAt: now },
      $setOnInsert: { createdAt: now },
    },
    {
      upsert: true,
      returnDocument: "after", // v4+
      returnOriginal: false, // v3
    }
  );

  let doc = res?.value || null;
  if (!doc) doc = await locks.findOne({ _id: key });
  if (!doc) return false;

  if (String(doc.owner) !== String(owner)) return false;

  const exp = asDate(doc.expiresAt);
  if (!exp) return false;

  return exp.getTime() > Date.now();
}

async function renewDistributedLock(db, key, owner, locksCol = COLS.settlement.locks) {
  const { ttlMs } = lockConfig();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  const r = await db.collection(locksCol).updateOne(
    { _id: key, owner },
    { $set: { updatedAt: now, expiresAt } }
  );

  return Number(r?.matchedCount || 0) > 0;
}

function startLockHeartbeat(db, key, owner, locksCol = COLS.settlement.locks) {
  const { ttlMs } = lockConfig();
  const everyMs = clamp(Math.floor(ttlMs / 2), 500, 15000);

  let stopped = false;

  const t = setInterval(async () => {
    if (stopped) return;
    try {
      const ok = await renewDistributedLock(db, key, owner, locksCol);
      if (!ok) {
        logger.warn({ key, owner }, "ledger_lock_heartbeat_lost");
        clearInterval(t);
        stopped = true;
      }
    } catch (e) {
      logger.warn({ key, owner, err: e }, "ledger_lock_heartbeat_error");
    }
  }, everyMs);

  t.unref?.();

  return () => {
    stopped = true;
    clearInterval(t);
  };
}

async function releaseDistributedLock(db, key, owner, locksCol = COLS.settlement.locks) {
  await db.collection(locksCol).deleteOne({ _id: key, owner }).catch(() => {});
}

async function writeAdminActionStart(db, { idempotencyKey, meta, action }, actionsCol = COLS.settlement.actions) {
  const now = new Date();
  const col = db.collection(actionsCol);

  // If idempotencyKey exists, use stable _id so "same key" is inherently unique
  const actionId = idempotencyKey ? `commit:${idempotencyKey}` : undefined;

  if (!idempotencyKey) {
    const ins = await col.insertOne({
      action,
      status: "IN_PROGRESS",
      idempotencyKey: null,
      requestId: meta?.requestId ?? null,
      adminUserId: meta?.adminUserId ?? null,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
      deviceId: meta?.deviceId ?? null,
      createdAt: now,
      updatedAt: now,
    });
    return { actionId: String(ins.insertedId), replay: false, existing: null };
  }

  // Atomic idempotency start:
  // - If SUCCESS exists => replay
  // - If IN_PROGRESS exists => 409
  // - If FAILED exists => allow retry (set IN_PROGRESS again)
  const res = await col.findOneAndUpdate(
    { _id: actionId },
    {
      $setOnInsert: {
        action,
        idempotencyKey,
        createdAt: now,
      },
      $set: {
        status: "IN_PROGRESS",
        requestId: meta?.requestId ?? null,
        adminUserId: meta?.adminUserId ?? null,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
        deviceId: meta?.deviceId ?? null,
        updatedAt: now,
        error: null,
      },
    },
    { upsert: true, returnDocument: "before", returnOriginal: true }
  );

  const prev = res?.value || null;

  if (prev?.status === "SUCCESS" && prev?.result) {
    return { actionId, replay: true, existing: prev };
  }

  if (prev?.status === "IN_PROGRESS") {
    const err = new Error("Ledger commit already in progress");
    err.status = 409;
    err.details = {
      idempotencyKey,
      actionId,
      status: prev.status,
      updatedAt: prev.updatedAt ? toIsoMaybe(prev.updatedAt) : null,
    };
    throw err;
  }

  // prev is null (new) or FAILED/unknown -> proceed
  return { actionId, replay: false, existing: prev };
}

async function writeAdminActionFinish(db, actionId, status, payload, actionsCol = COLS.settlement.actions) {
  const now = new Date();
  const col = db.collection(actionsCol);

  await col.updateOne(
    { _id: actionId },
    {
      $set: {
        status,
        updatedAt: now,
        ...(status === "SUCCESS" ? { result: payload, error: null } : {}),
        ...(status === "FAILED" ? { error: payload, result: null } : {}),
      },
    }
  );
}

async function commitNextBlock({ sealedByUserId, maxItems = 500, idempotencyKey, meta } = {}) {
  const db = getMongoDb();
  const blocksCol = COLS.settlement.blocks;
  const itemsCol = COLS.settlement.items;

  const { actionId, replay, existing } = await writeAdminActionStart(db, {
    idempotencyKey,
    meta,
    action: "COMMIT",
  });

  if (replay) {
    return { ...existing.result, replay: true, actionId };
  }

  const owner = genOwner();
  const locked = await acquireDistributedLock(db, LOCK_KEY_COMMIT_NEXT, owner);

  if (!locked) {
    const info = await getLockInfo(db, LOCK_KEY_COMMIT_NEXT);
    const err = new Error("Ledger commit already in progress");
    err.status = 409;
    err.details = info ? { lock: info, actionId } : { lock: null, actionId };
    await writeAdminActionFinish(db, actionId, "FAILED", {
      message: err.message,
      status: err.status,
      details: err.details ?? null,
    });
    throw err;
  }

  const stopHeartbeat = startLockHeartbeat(db, LOCK_KEY_COMMIT_NEXT, owner);

  try {
    const tip = await getTipBlock(db);
    const height = tip ? Number(tip.height) + 1 : 1;
    const prevHash = tip ? String(tip.blockHash) : sha256Hex("GENESIS");    const curWallet = await getCursor(db, "wallet_transactions");
    const curTrade = await getCursor(db, "trade_fills");


    const fetchLimit = Math.max(50, Math.min(2000, Number(maxItems)));

   const [walRows, trdRows] = await Promise.all([
  fetchWalletTransactions(curWallet, fetchLimit),
  fetchTradeFills(curTrade, fetchLimit),
]);


    const items = [
  ...walRows.map((r) => normalizeItem("wallet_transactions", r)),
  ...trdRows.map((r) => normalizeItem("trade_fills", r)),
];


    items.sort((a, b) => {
      const ta = a.createdAt || "";
      const tb = b.createdAt || "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      if (a.source < b.source) return -1;
      if (a.source > b.source) return 1;
      return a.sourceId - b.sourceId;
    });

    const capped = items.slice(0, Number(maxItems));

    if (!capped.length) {
      const out = {
        committed: false,
        reason: "No new rows to commit",
        tip: tip
          ? { height: Number(tip.height), blockHash: String(tip.blockHash) }
          : { height: 0, blockHash: sha256Hex("GENESIS") },
      };

      await writeAdminActionFinish(db, actionId, "SUCCESS", out);
      return { ...out, actionId };
    }

    const leafHashes = capped.map((x) => x.payloadHash);
    const merkleRoot = merkleRootHex(leafHashes);

    const commitKey = sha256Hex(`${height}|${prevHash}|${merkleRoot}`);

    const blockHash = sha256Hex(
      canonicalStringify({
        height,
        prevHash,
        merkleRoot,
        commitKey,
        sealedByUserId,
      })
    );

    const now = new Date();

    let blockId = null;
    try {
      const blockDoc = {
        height,
        prevHash,
        merkleRoot,
        commitKey,
        blockHash,
        sealedByUserId,
        itemsCount: capped.length,
        createdAt: now,
        sources: {
          wallet_transactions: { fromIdExclusive: curWallet },
          trade_fills: { fromIdExclusive: curTrade },
        },

        status: "SEALED",
        version: 1,
      };

      const ins = await db.collection(blocksCol).insertOne(blockDoc);
      blockId = ins.insertedId;

      const itemDocs = capped.map((x, idx) => ({
        blockId,
        blockHeight: height,
        idx,
        source: x.source,
        sourceId: x.sourceId,
        createdAt: x.createdAt ? new Date(x.createdAt) : null,
        payloadHash: x.payloadHash,
        payload: x.payload,
      }));

      await db.collection(itemsCol).insertMany(itemDocs, { ordered: true });

      const walletPairs = itemDocs
        .filter((d) => d.source === "wallet_transactions")
        .map((d) => ({ id: d.sourceId, idx: d.idx }));

      const tradePairs = itemDocs
        .filter((d) => d.source === "trade_fills")
        .map((d) => ({ id: d.sourceId, idx: d.idx }));

      await updateMySqlLedgerPointers({
        height,
        blockHash,
        commitKey,
        committedAt: now,
        walletPairs,
        securityPairs: [],
        tradePairs,
      });


      const maxWal = capped
  .filter((x) => x.source === "wallet_transactions")
  .reduce((m, x) => Math.max(m, x.sourceId), curWallet);

const maxTrd = capped
  .filter((x) => x.source === "trade_fills")
  .reduce((m, x) => Math.max(m, x.sourceId), curTrade);

await Promise.all([  setCursor(db, "wallet_transactions", maxWal),
  setCursor(db, "trade_fills", maxTrd),
]);


      const out = {
        committed: true,
        height,
        prevHash,
        merkleRoot,
        blockHash,
        commitKey,
        itemsCount: capped.length,
      };

      logger.info({ ...out, actionId }, "ledger_block_committed");

      await writeAdminActionFinish(db, actionId, "SUCCESS", out);
      return { ...out, actionId };
    } catch (e) {
      if (blockId) {
        await db.collection(itemsCol).deleteMany({ blockId }).catch(() => {});
        await db.collection(blocksCol).deleteOne({ _id: blockId }).catch(() => {});
      }

      const msg = String(e?.message || "");
      if (msg.includes("E11000")) {
        const err = new Error("Ledger commit conflict (try again)");
        err.status = 409;
        await writeAdminActionFinish(db, actionId, "FAILED", { message: err.message, status: err.status });
        throw err;
      }

      await writeAdminActionFinish(db, actionId, "FAILED", { message: msg || "Unknown error", status: 500 });
      throw e;
    }
  } finally {
    stopHeartbeat?.();
    await releaseDistributedLock(db, LOCK_KEY_COMMIT_NEXT, owner);
  }
}


async function commitNextAuditBlock({ sealedByUserId, maxItems = 500, idempotencyKey, meta } = {}) {
  const db = getMongoDb();

  const { actionId, replay, existing } = await writeAdminActionStart(
    db,
    { idempotencyKey, meta, action: "AUDIT_COMMIT" },
    COLS.audit.actions
  );

  if (replay) {
    return { ...existing.result, replay: true, actionId };
  }

  const owner = genOwner();
  const locked = await acquireDistributedLock(db, LOCK_KEY_COMMIT_NEXT_AUDIT, owner, COLS.audit.locks);

  if (!locked) {
    const info = await getLockInfo(db, LOCK_KEY_COMMIT_NEXT_AUDIT, COLS.audit.locks);
    const err = new Error("Audit ledger commit already in progress");
    err.status = 409;
    err.details = info ? { lock: info, actionId } : { lock: null, actionId };
    await writeAdminActionFinish(
      db,
      actionId,
      "FAILED",
      { message: err.message, status: err.status, details: err.details ?? null },
      COLS.audit.actions
    );
    throw err;
  }

  const stopHeartbeat = startLockHeartbeat(db, LOCK_KEY_COMMIT_NEXT_AUDIT, owner, COLS.audit.locks);

  try {
    const tip = await getTipBlock(db, COLS.audit.blocks);
    const height = tip ? Number(tip.height) + 1 : 1;
    const prevHash = tip ? String(tip.blockHash) : sha256Hex("GENESIS");

    const curSecurity = await getCursor(db, "security_logs", COLS.audit.cursors);

    const fetchLimit = Math.max(50, Math.min(2000, Number(maxItems)));
    const secRows = await fetchSecurityLogs(curSecurity, fetchLimit);

    const items = secRows.map((r) => normalizeItem("security_logs", r));

    items.sort((a, b) => {
      const ta = a.createdAt || "";
      const tb = b.createdAt || "";
      if (ta < tb) return -1;
      if (ta > tb) return 1;
      if (a.source < b.source) return -1;
      if (a.source > b.source) return 1;
      return a.sourceId - b.sourceId;
    });

    const capped = items.slice(0, Number(maxItems));

    if (!capped.length) {
      const out = {
        committed: false,
        reason: "No new rows to commit",
        tip: tip
          ? { height: Number(tip.height), blockHash: String(tip.blockHash) }
          : { height: 0, blockHash: sha256Hex("GENESIS") },
      };

      await writeAdminActionFinish(db, actionId, "SUCCESS", out, COLS.audit.actions);
      return { ...out, actionId };
    }

    const leafHashes = capped.map((x) => x.payloadHash);
    const merkleRoot = merkleRootHex(leafHashes);

    const commitKey = sha256Hex(`${height}|${prevHash}|${merkleRoot}`);

    const blockHash = sha256Hex(
      canonicalStringify({
        height,
        prevHash,
        merkleRoot,
        commitKey,
        sealedByUserId,
      })
    );

    const now = new Date();

    let blockId = null;
    try {
      const blockDoc = {
        height,
        prevHash,
        merkleRoot,
        commitKey,
        blockHash,
        sealedByUserId,
        itemsCount: capped.length,
        createdAt: now,
        sources: {
          security_logs: { fromIdExclusive: curSecurity },
        },
        status: "SEALED",
        version: 1,
      };

      const ins = await db.collection(COLS.audit.blocks).insertOne(blockDoc);
      blockId = ins.insertedId;

      const itemDocs = capped.map((x, idx) => ({
        blockId,
        blockHeight: height,
        idx,
        source: x.source,
        sourceId: x.sourceId,
        createdAt: x.createdAt ? new Date(x.createdAt) : null,
        payloadHash: x.payloadHash,
        payload: x.payload,
      }));

      await db.collection(COLS.audit.items).insertMany(itemDocs, { ordered: true });

      const securityPairs = itemDocs.map((d) => ({ id: d.sourceId, idx: d.idx }));

      await updateMySqlLedgerPointers({
        height,
        blockHash,
        commitKey,
        committedAt: now,
        securityPairs,
        walletPairs: [],
        tradePairs: [],
      });

      const maxSec = capped.reduce((m, x) => Math.max(m, x.sourceId), curSecurity);
      await setCursor(db, "security_logs", maxSec, COLS.audit.cursors);

      const out = {
        committed: true,
        height,
        prevHash,
        merkleRoot,
        blockHash,
        commitKey,
        itemsCount: capped.length,
      };

      logger.info({ ...out, actionId }, "audit_ledger_block_committed");

      await writeAdminActionFinish(db, actionId, "SUCCESS", out, COLS.audit.actions);
      return { ...out, actionId };
    } catch (e) {
      if (blockId) {
        await db.collection(COLS.audit.items).deleteMany({ blockId }).catch(() => {});
        await db.collection(COLS.audit.blocks).deleteOne({ _id: blockId }).catch(() => {});
      }

      const msg = String(e?.message || "");
      if (msg.includes("E11000")) {
        const err = new Error("Audit ledger commit conflict (try again)");
        err.status = 409;
        await writeAdminActionFinish(db, actionId, "FAILED", { message: err.message, status: err.status }, COLS.audit.actions);
        throw err;
      }

      await writeAdminActionFinish(db, actionId, "FAILED", { message: msg || "Unknown error", status: 500 }, COLS.audit.actions);
      throw e;
    }
  } finally {
    stopHeartbeat?.();
    await releaseDistributedLock(db, LOCK_KEY_COMMIT_NEXT_AUDIT, owner, COLS.audit.locks);
  }
}


async function verifyChainWithCols({ maxBlocks = 2000, blocksCol = COLS.settlement.blocks, itemsCol = COLS.settlement.items } = {}) {
  const db = getMongoDb();

  const blocks = await db
    .collection(blocksCol)
    .find(
      {},
      {
        projection: {
          _id: 1,
          height: 1,
          prevHash: 1,
          merkleRoot: 1,
          blockHash: 1,
          commitKey: 1,
          sealedByUserId: 1,
        },
      }
    )
    .sort({ height: 1 })
    .limit(Number(maxBlocks))
    .toArray();

  if (!blocks.length) return { ok: true, verified: 0, tip: null };

  let expectedPrev = sha256Hex("GENESIS");

  for (const b of blocks) {
    const height = Number(b.height);

    if (String(b.prevHash) !== expectedPrev) {
      const err = new Error(`Chain broken at height=${height}: prevHash mismatch`);
      err.status = 409;
      throw err;
    }

    const items = await db
      .collection(itemsCol)
      .find({ blockId: b._id }, { projection: { idx: 1, payloadHash: 1 } })
      .sort({ idx: 1 })
      .toArray();

    const leafHashes = items.map((x) => String(x.payloadHash));
    const recomputedMerkle = merkleRootHex(leafHashes);

    if (String(b.merkleRoot) !== recomputedMerkle) {
      const err = new Error(`Merkle mismatch at height=${height}`);
      err.status = 409;
      throw err;
    }

    const recomputedCommitKey = sha256Hex(`${height}|${String(b.prevHash)}|${String(b.merkleRoot)}`);
    if (String(b.commitKey) !== recomputedCommitKey) {
      const err = new Error(`CommitKey mismatch at height=${height}`);
      err.status = 409;
      throw err;
    }

    const recomputedBlockHash = sha256Hex(
      canonicalStringify({
        height,
        prevHash: String(b.prevHash),
        merkleRoot: String(b.merkleRoot),
        commitKey: String(b.commitKey),
        sealedByUserId: String(b.sealedByUserId),
      })
    );

    if (String(b.blockHash) !== recomputedBlockHash) {
      const err = new Error(`BlockHash mismatch at height=${height}`);
      err.status = 409;
      throw err;
    }

    expectedPrev = String(b.blockHash);
  }

  const tip = blocks[blocks.length - 1];
  return {
  ok: true,
  verified: blocks.length,
  checkedBlocks: blocks.length, // alias for script compatibility
  tip: { height: Number(tip.height), blockHash: String(tip.blockHash) },
};

}

async function verifyChain(opts = {}) {
  return verifyChainWithCols({ ...opts, blocksCol: COLS.settlement.blocks, itemsCol: COLS.settlement.items });
}

async function verifyAuditChain(opts = {}) {
  return verifyChainWithCols({ ...opts, blocksCol: COLS.audit.blocks, itemsCol: COLS.audit.items });
}

async function listBlocks({ limit = 50, offset = 0, blocksCol = COLS.settlement.blocks } = {}) {
  const db = getMongoDb();

  const nLimit = Math.max(1, Math.min(200, Number(limit)));
  const nOffset = Math.max(0, Number(offset));

  const [items, total] = await Promise.all([
    db
      .collection(blocksCol)
      .find({}, { projection: { _id: 0 } })
      .sort({ height: -1 })
      .skip(nOffset)
      .limit(nLimit)
      .toArray(),
    db.collection(blocksCol).countDocuments({}),
  ]);

  return { total, items };
}

async function getBlockByHeight(height, { includeItems = true, blocksCol = COLS.settlement.blocks, itemsCol = COLS.settlement.items } = {}) {
  const db = getMongoDb();

  const h = Number(height);
  if (!Number.isFinite(h) || h < 1) {
    const err = new Error("Invalid height");
    err.status = 400;
    throw err;
  }

  const block = await db.collection(blocksCol).findOne({ height: h });
  if (!block) {
    const err = new Error("Block not found");
    err.status = 404;
    throw err;
  }

  if (!includeItems) return { block };

  const items = await db
    .collection(itemsCol)
    .find({ blockId: block._id }, { projection: { _id: 0, blockId: 0 } })
    .sort({ idx: 1 })
    .toArray();

  return { block, items };
}

async function listLocks({ locksCol = COLS.settlement.locks } = {}) {
  const db = getMongoDb();
  const docs = await db
    .collection(locksCol)
    .find({}, { projection: { _id: 1, owner: 1, expiresAt: 1, updatedAt: 1, createdAt: 1 } })
    .sort({ _id: 1 })
    .toArray();

  return {
    count: docs.length,
    locks: docs.map((d) => ({
      key: d._id,
      owner: d.owner ?? null,
      expiresAt: toIsoMaybe(d.expiresAt),
      updatedAt: toIsoMaybe(d.updatedAt),
      createdAt: toIsoMaybe(d.createdAt),
    })),
  };
}

async function adminUnlock({ key, all, staleOnly, maxAgeMs, locksCol = COLS.settlement.locks } = {}) {
  const db = getMongoDb();
  const locks = db.collection(locksCol);

  if (all) {
    if (staleOnly) {
      const { staleMs } = lockConfig();
      const cutoff = new Date(Date.now() - Number(maxAgeMs || staleMs));
      const before = await locks.find({ updatedAt: { $lte: cutoff } }, { projection: { _id: 1 } }).toArray();
      const keys = before.map((x) => x._id);
      const r = await locks.deleteMany({ updatedAt: { $lte: cutoff } });
      return { unlocked: true, mode: "all_stale", deleted: Number(r?.deletedCount || 0), keys };
    }

    const before = await locks.find({}, { projection: { _id: 1 } }).toArray();
    const keys = before.map((x) => x._id);
    const r = await locks.deleteMany({});
    return { unlocked: true, mode: "all", deleted: Number(r?.deletedCount || 0), keys };
  }

  if (!key) {
    const err = new Error("Provide key or all");
    err.status = 400;
    throw err;
  }

  const r = await locks.deleteOne({ _id: String(key) });
  return { unlocked: true, mode: "one", key: String(key), deleted: Number(r?.deletedCount || 0) };
}

async function finalizeBlock({ height, finalizedByUserId, meta, blocksCol = COLS.settlement.blocks, itemsCol = COLS.settlement.items } = {}) {
  const db = getMongoDb();

  const h = Number(height);
  if (!Number.isFinite(h) || h < 1) {
    const err = new Error("Invalid height");
    err.status = 400;
    throw err;
  }

  const block = await db.collection(blocksCol).findOne({ height: h });
  if (!block) {
    const err = new Error("Block not found");
    err.status = 404;
    throw err;
  }

  if (block.status === "FINALIZED") {
    return { finalized: false, reason: "Already finalized", height: h, blockHash: String(block.blockHash) };
  }

  // Lightweight integrity check for THIS block before finalizing
  const items = await db
    .collection(itemsCol)
    .find({ blockId: block._id }, { projection: { idx: 1, payloadHash: 1 } })
    .sort({ idx: 1 })
    .toArray();

  const leafHashes = items.map((x) => String(x.payloadHash));
  const recomputedMerkle = merkleRootHex(leafHashes);

  if (String(block.merkleRoot) !== recomputedMerkle) {
    const err = new Error("Merkle mismatch (cannot finalize)");
    err.status = 409;
    throw err;
  }

  const recomputedCommitKey = sha256Hex(`${h}|${String(block.prevHash)}|${String(block.merkleRoot)}`);
  if (String(block.commitKey) !== recomputedCommitKey) {
    const err = new Error("CommitKey mismatch (cannot finalize)");
    err.status = 409;
    throw err;
  }

  const recomputedBlockHash = sha256Hex(
    canonicalStringify({
      height: h,
      prevHash: String(block.prevHash),
      merkleRoot: String(block.merkleRoot),
      commitKey: String(block.commitKey),
      sealedByUserId: String(block.sealedByUserId),
    })
  );

  if (String(block.blockHash) !== recomputedBlockHash) {
    const err = new Error("BlockHash mismatch (cannot finalize)");
    err.status = 409;
    throw err;
  }

  const now = new Date();

  await db.collection(blocksCol).updateOne(
    { _id: block._id },
    {
      $set: {
        status: "FINALIZED",
        finalizedAt: now,
        finalizedByUserId,
        finalizeMeta: {
          requestId: meta?.requestId ?? null,
          ip: meta?.ip ?? null,
          userAgent: meta?.userAgent ?? null,
          deviceId: meta?.deviceId ?? null,
        },
      },
    }
  );

  return { finalized: true, height: h, blockHash: String(block.blockHash), finalizedAt: now.toISOString() };
}

async function listAdminActions({ limit = 50, offset = 0, actionsCol = COLS.settlement.actions } = {}) {
  const db = getMongoDb();

  const nLimit = Math.max(1, Math.min(200, Number(limit)));
  const nOffset = Math.max(0, Number(offset));

  const [items, total] = await Promise.all([
    db
      .collection(actionsCol)
      .find({}, { projection: { _id: 1, action: 1, status: 1, idempotencyKey: 1, adminUserId: 1, requestId: 1, createdAt: 1, updatedAt: 1, result: 1, error: 1 } })
      .sort({ createdAt: -1 })
      .skip(nOffset)
      .limit(nLimit)
      .toArray(),
    db.collection(actionsCol).countDocuments({}),
  ]);

  return { total, items };
}

async function getWalletReceipt({ txId, requesterUserId, requesterRole } = {}) {
  const id = Number(txId);
  if (!Number.isFinite(id) || id < 1) {
    const err = new Error("Invalid txId");
    err.status = 400;
    throw err;
  }

  const [rows] = await pool.query(
    `
    SELECT
      id, user_id, type, amount, balance_after, description, reference_id, status, created_at,
      ledger_block_height, ledger_block_hash, ledger_commit_key, ledger_item_idx, ledger_committed_at
    FROM wallet_transactions
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  if (!rows.length) {
    const err = new Error("Wallet transaction not found");
    err.status = 404;
    throw err;
  }

  const row = rows[0];

  if (requesterRole !== "admin" && String(row.user_id) !== String(requesterUserId)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  if (row.ledger_block_height == null || row.ledger_item_idx == null) {
    const err = new Error("Transaction not yet committed to ledger");
    err.status = 409;
    err.details = { txId: id };
    throw err;
  }

  return buildReceiptForRow({
    source: "wallet_transactions",
    sqlRow: row,
  });
}

async function getTradeReceipt({ tradeId, requesterUserId, requesterRole } = {}) {
  const id = Number(tradeId);
  if (!Number.isFinite(id) || id < 1) {
    const err = new Error("Invalid tradeId");
    err.status = 400;
    throw err;
  }

  const [rows] = await pool.query(
    `
    SELECT
      id, user_id, side, symbol, qty, price,
      gross_quote, fee_quote, net_quote,
      wallet_tx_id, reference_id, request_id, status, created_at,
      ledger_block_height, ledger_block_hash, ledger_commit_key, ledger_item_idx, ledger_committed_at
    FROM trade_fills
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  if (!rows.length) {
    const err = new Error("Trade not found");
    err.status = 404;
    throw err;
  }

  const row = rows[0];

  if (requesterRole !== "admin" && String(row.user_id) !== String(requesterUserId)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }

  if (row.ledger_block_height == null || row.ledger_item_idx == null) {
    const err = new Error("Trade not yet committed to ledger");
    err.status = 409;
    err.details = { tradeId: id };
    throw err;
  }

  return buildReceiptForRow({
    source: "trade_fills",
    sqlRow: row,
  });
}


async function getSecurityReceipt({ logId, requesterUserId, requesterRole } = {}) {
  const id = Number(logId);
  if (!Number.isFinite(id) || id < 1) {
    const err = new Error("Invalid logId");
    err.status = 400;
    throw err;
  }

  const [rows] = await pool.query(
    `
    SELECT
      id, user_id, event_type, ip, user_agent, metadata, created_at,
      ledger_block_height, ledger_block_hash, ledger_commit_key, ledger_item_idx, ledger_committed_at
    FROM security_logs
    WHERE id = ?
    LIMIT 1
    `,
    [id]
  );

  if (!rows.length) {
    const err = new Error("Security log not found");
    err.status = 404;
    throw err;
  }

  const row = rows[0];

  // user can only see their own logs; null user_id => admin only
  if (requesterRole !== "admin") {
    if (!row.user_id || String(row.user_id) !== String(requesterUserId)) {
      const err = new Error("Forbidden");
      err.status = 403;
      throw err;
    }
  }

  if (row.ledger_block_height == null || row.ledger_item_idx == null) {
    const err = new Error("Security log not yet committed to ledger");
    err.status = 409;
    err.details = { logId: id };
    throw err;
  }

  return buildReceiptForRow({
    source: "security_logs",
    sqlRow: row,
  });
}

async function buildReceiptForRow({ source, sqlRow } = {}) {
  const db = getMongoDb();

  const isAudit = String(source) === "security_logs";
  const blocksCol = isAudit ? COLS.audit.blocks : COLS.settlement.blocks;
  const itemsCol = isAudit ? COLS.audit.items : COLS.settlement.items;

  const height = Number(sqlRow.ledger_block_height);
  const idx = Number(sqlRow.ledger_item_idx);

  const block = await db.collection(blocksCol).findOne({ height });
  if (!block) {
    const err = new Error("Block not found for receipt");
    err.status = 404;
    throw err;
  }

  // Basic pointer integrity checks (fast)
  if (sqlRow.ledger_block_hash && String(sqlRow.ledger_block_hash) !== String(block.blockHash)) {
    const err = new Error("Ledger pointer mismatch (blockHash)");
    err.status = 409;
    throw err;
  }
  if (sqlRow.ledger_commit_key && String(sqlRow.ledger_commit_key) !== String(block.commitKey)) {
    const err = new Error("Ledger pointer mismatch (commitKey)");
    err.status = 409;
    throw err;
  }

  const [hashRows, item] = await Promise.all([
    db
      .collection(itemsCol)
      .find({ blockId: block._id }, { projection: { _id: 0, idx: 1, payloadHash: 1 } })
      .sort({ idx: 1 })
      .toArray(),
    db.collection(itemsCol).findOne(
      { blockId: block._id, idx },
      { projection: { _id: 0, idx: 1, source: 1, sourceId: 1, payloadHash: 1, payload: 1 } }
    ),
  ]);

  if (!item) {
    const err = new Error("Ledger item not found for receipt");
    err.status = 404;
    throw err;
  }

  // Ensure the item is actually for THIS sql row
  if (String(item.source) !== String(source) || Number(item.sourceId) !== Number(sqlRow.id)) {
    const err = new Error("Ledger item mismatch (source/sourceId)");
    err.status = 409;
    err.details = { expected: { source, id: Number(sqlRow.id) }, got: { source: item.source, id: item.sourceId } };
    throw err;
  }

  const leafHashes = hashRows.map((x) => String(x.payloadHash));
  const proof = buildMerkleProof(leafHashes, idx);

  // Strong check: recompute hash from SQL row using the SAME normalization used in commit
  const expected = normalizeItem(source, sqlRow); // uses id/user_id/type/amount/... created_at etc.
  const payloadHashMatches = String(expected.payloadHash) === String(item.payloadHash);

  const proofOk = verifyMerkleProof({
    leafHash: proof.leafHash,
    proof: proof.proof,
    merkleRoot: String(block.merkleRoot),
  });

  return {
    source,
    sourceId: Number(sqlRow.id),
    pointers: {
      height,
      idx,
      blockHash: String(block.blockHash),
      commitKey: String(block.commitKey),
      committedAt: sqlRow.ledger_committed_at ? new Date(sqlRow.ledger_committed_at).toISOString() : null,
    },
    blockHeader: {
      height: Number(block.height),
      prevHash: String(block.prevHash),
      merkleRoot: String(block.merkleRoot),
      commitKey: String(block.commitKey),
      blockHash: String(block.blockHash),
      status: String(block.status),
      sealedByUserId: block.sealedByUserId ? String(block.sealedByUserId) : null,
      createdAt: block.createdAt ? new Date(block.createdAt).toISOString() : null,
      finalizedAt: block.finalizedAt ? new Date(block.finalizedAt).toISOString() : null,
    },
    leaf: {
      leafIndex: proof.leafIndex,
      leafHash: proof.leafHash,
      payloadHashMatches,
      payloadFromLedger: item.payload, // what was committed
    },
    merkleProof: {
      algorithm: "sha256(concat(left,right))",
      steps: proof.proof,
    },
    verification: {
      proofOk,
    },
  };
}




// =========================
// Audit ledger wrappers
// =========================

async function listAuditBlocks({ limit = 50, offset = 0 } = {}) {
  return listBlocks({ limit, offset, blocksCol: COLS.audit.blocks });
}

async function getAuditBlockByHeight(height, { includeItems = true } = {}) {
  return getBlockByHeight(height, { includeItems, blocksCol: COLS.audit.blocks, itemsCol: COLS.audit.items });
}

async function listAuditLocks() {
  return listLocks({ locksCol: COLS.audit.locks });
}

async function adminAuditUnlock(body = {}) {
  return adminUnlock({ ...body, locksCol: COLS.audit.locks });
}

async function finalizeAuditBlock({ height, finalizedByUserId, meta } = {}) {
  return finalizeBlock({ height, finalizedByUserId, meta, blocksCol: COLS.audit.blocks, itemsCol: COLS.audit.items });
}

async function listAuditActions({ limit = 50, offset = 0 } = {}) {
  return listAdminActions({ limit, offset, actionsCol: COLS.audit.actions });
}


module.exports = {
  // Settlement ledger
  commitNextBlock,
  verifyChain,
  listBlocks,
  getBlockByHeight,
  listLocks,
  adminUnlock,
  finalizeBlock,
  listAdminActions,

  // Audit ledger
  commitNextAuditBlock,
  verifyAuditChain,
  listAuditBlocks,
  getAuditBlockByHeight,
  listAuditLocks,
  adminAuditUnlock,
  finalizeAuditBlock,
  listAuditActions,

  // Receipts
  getWalletReceipt,
  getSecurityReceipt,
  getTradeReceipt,
};
