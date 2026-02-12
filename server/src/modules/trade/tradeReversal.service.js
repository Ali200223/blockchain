// server/src/modules/trade/tradeReversal.service.js
const { pool } = require("../../config/mysql");

function httpError(status, message, details) {
  const e = new Error(message);
  e.status = status;
  if (details) e.details = details;
  return e;
}

function isAdminRole(role) {
  return String(role || "").toLowerCase() === "admin";
}

// FIX: net_quote for BUY can be negative (wallet debit). Reversal must use magnitude.
function absDecStr(v) {
  const s = String(v ?? "").trim();
  if (s.startsWith("-")) return s.slice(1);
  if (s.startsWith("+")) return s.slice(1);
  return s;
}

function isValidDecStr(s) {
  return /^[0-9]+(\.[0-9]+)?$/.test(String(s));
}

let schemaCache = null;

async function getTableCols(conn, tableName) {
  const [rows] = await conn.query(
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

function pickCol(cols, candidates) {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

async function loadSchema(conn) {
  if (schemaCache) return schemaCache;

  const tfCols = await getTableCols(conn, "trade_fills");

  const s = {
    tf: {
      userId: pickCol(tfCols, ["user_id", "userId"]),
      symbol: pickCol(tfCols, ["symbol"]),
      side: pickCol(tfCols, ["side", "type"]),
      qty: pickCol(tfCols, ["quantity", "qty"]),
      price: pickCol(tfCols, ["price"]),
      // legacy/alternate quote column if present
      quote: pickCol(tfCols, ["quote_amount", "quoteAmount", "notional"]),
      // preferred quote breakdown (present in your trading schema)
      grossQuote: pickCol(tfCols, ["gross_quote"]),
      feeQuote: pickCol(tfCols, ["fee_quote"]),
      netQuote: pickCol(tfCols, ["net_quote"]),
      ref: pickCol(tfCols, ["reference_id", "referenceId", "ref_id"]),
      status: pickCol(tfCols, ["status"]),
      reversedAt: pickCol(tfCols, ["reversed_at"]),
      reversedBy: pickCol(tfCols, ["reversed_by"]),
      reversalRef: pickCol(tfCols, ["reversal_reference_id"]),
      reversalWalletTx: pickCol(tfCols, ["reversal_wallet_tx_id"]),
    },
  };

  const missing = [];
  for (const k of ["userId", "symbol", "side", "qty", "price", "ref"]) {
    if (!s.tf[k]) missing.push(`trade_fills.${k}`);
  }
  if (missing.length) {
    throw httpError(500, "Trade reversal schema mismatch", { missing });
  }

  schemaCache = s;
  return s;
}

async function reverseTradeFill({ tradeFillId, referenceId, reason, actor, requestId }) {
  if (!Number.isFinite(tradeFillId) || tradeFillId <= 0) {
    throw httpError(400, "Invalid tradeFillId");
  }
  if (!referenceId || String(referenceId).trim().length < 8) {
    throw httpError(400, "Invalid referenceId");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const schema = await loadSchema(conn);
    const tf = schema.tf;

    // Build quote expressions:
    // - Prefer net_quote (fee-safe, what actually hit the wallet)
    // - Otherwise fall back to quote column, otherwise qty*price
    const baseQuoteExpr = tf.quote
      ? `COALESCE(tf.\`${tf.quote}\`, ROUND(tf.\`${tf.qty}\` * tf.\`${tf.price}\`, 2))`
      : `ROUND(tf.\`${tf.qty}\` * tf.\`${tf.price}\`, 2)`;

    const netQuoteExpr = tf.netQuote ? `tf.\`${tf.netQuote}\`` : baseQuoteExpr;
    const grossQuoteExpr = tf.grossQuote ? `tf.\`${tf.grossQuote}\`` : `NULL`;
    const feeQuoteExpr = tf.feeQuote ? `tf.\`${tf.feeQuote}\`` : `NULL`;

    const statusExpr = tf.status ? `tf.\`${tf.status}\`` : `'FILLED'`;

    // Lock fill
    const [fillRows] = await conn.query(
      `
      SELECT
        tf.id,
        tf.\`${tf.userId}\` AS user_id,
        tf.\`${tf.symbol}\` AS symbol,
        tf.\`${tf.side}\`   AS side,
        tf.\`${tf.qty}\`    AS quantity,
        tf.\`${tf.price}\`  AS price,
        ${baseQuoteExpr}    AS quote_amount,
        ${grossQuoteExpr}   AS gross_quote,
        ${feeQuoteExpr}     AS fee_quote,
        ${netQuoteExpr}     AS net_quote_amount,
        ${statusExpr}       AS status
      FROM trade_fills tf
      WHERE tf.id = ?
      FOR UPDATE
      `,
      [tradeFillId]
    );

    if (fillRows.length === 0) throw httpError(404, "Trade fill not found");
    const fill = fillRows[0];

    const actorId = String(actor?.userId || actor?.id || "");
    const actorRole = actor?.role || "user";
    if (!actorId) throw httpError(401, "Unauthorized");

    const ownerId = String(fill.user_id);
    if (!isAdminRole(actorRole) && ownerId !== actorId) {
      throw httpError(403, "Forbidden");
    }

    // If already reversed -> idempotent OK
    if (String(fill.status).toUpperCase() === "REVERSED") {
      await conn.commit();
      return { tradeFillId: fill.id, status: "REVERSED", note: "already_reversed" };
    }

    // Prevent reversal if newer non-reversed fills exist for same user+symbol
    const newerWhere = tf.status ? `tf.\`${tf.status}\` <> 'REVERSED'` : `1=1`;

    const [newerRows] = await conn.query(
      `
      SELECT tf.id
      FROM trade_fills tf
      WHERE tf.\`${tf.userId}\` = ?
        AND tf.\`${tf.symbol}\` = ?
        AND ${newerWhere}
        AND tf.id > ?
      LIMIT 1
      FOR UPDATE
      `,
      [ownerId, fill.symbol, fill.id]
    );

    if (newerRows.length > 0) {
      throw httpError(409, "Reversal not allowed: newer fills exist for this symbol", {
        newerFillId: newerRows[0].id,
      });
    }

    const side = String(fill.side).toUpperCase();
    if (side !== "BUY" && side !== "SELL") {
      throw httpError(500, "Invalid trade side/type in DB", { side });
    }

    // Wallet lock
    const [walletRows] = await conn.query(
      `SELECT id, balance, status FROM wallets WHERE user_id = ? FOR UPDATE`,
      [ownerId]
    );
    if (walletRows.length === 0) throw httpError(409, "Wallet missing for user");
    const wallet = walletRows[0];
    if (String(wallet.status) !== "ACTIVE") throw httpError(409, "Wallet not active");

    // FIX: net_quote_amount can be negative for BUY (because wallet was debited).
    // Reversal must use positive magnitude; direction is controlled by deltaSign.
    const quoteAmountStr = absDecStr(fill.net_quote_amount ?? fill.quote_amount);

    if (!isValidDecStr(quoteAmountStr)) {
      throw httpError(500, "Invalid quote amount in DB", {
        net_quote_amount: fill.net_quote_amount,
        quote_amount: fill.quote_amount,
      });
    }

    // Reverse BUY credits wallet, reverse SELL debits wallet
    const deltaSign = side === "BUY" ? 1 : -1;

    // Compute new balance in SQL DECIMAL
    const [balRows] = await conn.query(
      `
      SELECT
        CAST(? AS DECIMAL(18,2)) AS amt,
        CAST(? AS DECIMAL(18,2)) AS bal,
        CAST((CAST(? AS DECIMAL(18,2)) + (CAST(? AS DECIMAL(18,2)) * ?)) AS DECIMAL(18,2)) AS bal_after
      `,
      [quoteAmountStr, String(wallet.balance), String(wallet.balance), quoteAmountStr, deltaSign]
    );
    const balAfter = balRows[0].bal_after;

    // Guard: no negative wallet (only relevant on reverse SELL)
    const [negRows] = await conn.query(`SELECT (CAST(? AS DECIMAL(18,2)) < 0) AS is_neg`, [String(balAfter)]);
    if (negRows[0].is_neg) throw httpError(409, "Insufficient wallet balance to reverse this SELL");

    // Holdings lock
    const [holdRows] = await conn.query(
      `SELECT id, quantity, avg_cost FROM portfolio_holdings WHERE user_id = ? AND symbol = ? FOR UPDATE`,
      [ownerId, fill.symbol]
    );
    if (holdRows.length === 0) throw httpError(409, "Holding row missing for symbol");

    // Reverse holdings
    if (side === "BUY") {
      // Reverse BUY: quantity -= fill.qty; avg_cost adjusted back
      await conn.query(
        `
        UPDATE portfolio_holdings
           SET
             avg_cost = CASE
               WHEN (quantity - CAST(? AS DECIMAL(36,18))) > 0 THEN
                 (
                   (quantity * avg_cost) -
                   (CAST(? AS DECIMAL(36,18)) * CAST(? AS DECIMAL(18,8)))
                 ) / (quantity - CAST(? AS DECIMAL(36,18)))
               ELSE 0
             END,
             quantity = quantity - CAST(? AS DECIMAL(36,18)),
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND symbol = ?
        `,
        [
          String(fill.quantity),
          String(fill.quantity),
          String(fill.price),
          String(fill.quantity),
          String(fill.quantity),
          ownerId,
          fill.symbol,
        ]
      );

      const [chk] = await conn.query(
        `SELECT (quantity < 0) AS neg FROM portfolio_holdings WHERE user_id = ? AND symbol = ?`,
        [ownerId, fill.symbol]
      );
      if (chk[0]?.neg) throw httpError(409, "Reversal would make holdings negative");
    } else {
      // Reverse SELL: quantity += fill.qty; avg_cost unchanged
      await conn.query(
        `
        UPDATE portfolio_holdings
           SET quantity = quantity + CAST(? AS DECIMAL(36,18)),
               updated_at = CURRENT_TIMESTAMP
         WHERE user_id = ? AND symbol = ?
        `,
        [String(fill.quantity), ownerId, fill.symbol]
      );
    }

    // Update wallet balance
    await conn.query(`UPDATE wallets SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [
      String(balAfter),
      wallet.id,
    ]);

    // Insert compensating wallet tx
    // Amount must be signed by deltaSign, but magnitude must be positive.
    const walletDelta = deltaSign === 1 ? quoteAmountStr : `-${quoteAmountStr}`;

    const [wtIns] = await conn.query(
      `
      INSERT INTO wallet_transactions
        (user_id, type, amount, balance_after, description, reference_id, status, created_at)
      VALUES
        (?, 'ADJUST', CAST(? AS DECIMAL(18,2)), CAST(? AS DECIMAL(18,2)),
         ?, ?, 'CONFIRMED', CURRENT_TIMESTAMP)
      `,
      [
        ownerId,
        walletDelta,
        String(balAfter),
        `Trade reversal: fill=${fill.id} side=${side} reason=${reason || "trade_reversal"} req=${requestId || "-"}`,
        referenceId,
      ]
    );
    const reversalWalletTxId = wtIns.insertId;

    // Mark trade fill reversed (only if the columns exist)
    const updates = [];
    if (tf.status) updates.push(`\`${tf.status}\` = 'REVERSED'`);
    if (tf.reversedAt) updates.push(`\`${tf.reversedAt}\` = CURRENT_TIMESTAMP`);
    if (tf.reversedBy) updates.push(`\`${tf.reversedBy}\` = ?`);
    if (tf.reversalRef) updates.push(`\`${tf.reversalRef}\` = ?`);
    if (tf.reversalWalletTx) updates.push(`\`${tf.reversalWalletTx}\` = ?`);

    if (updates.length === 0) {
      throw httpError(500, "Reversal metadata columns missing on trade_fills (run migration 013)");
    }

    const params = [];
    if (tf.reversedBy) params.push(isAdminRole(actorRole) ? actorId : ownerId);
    if (tf.reversalRef) params.push(referenceId);
    if (tf.reversalWalletTx) params.push(reversalWalletTxId);
    params.push(fill.id);

    await conn.query(`UPDATE trade_fills SET ${updates.join(", ")} WHERE id = ?`, params);

    await conn.commit();
    return { tradeFillId: fill.id, status: "REVERSED", reversalWalletTxId };
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {}
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { reverseTradeFill };
