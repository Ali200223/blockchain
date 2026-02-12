const { pool } = require("../../config/mysql");
const { logger } = require("../../config/logger");

/**
 * BigInt decimal helpers (avoid float drift)
 */
function pow10(n) {
  return 10n ** BigInt(n);
}

function parseDecToInt(v, scale) {
  const s = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) throw Object.assign(new Error("Invalid decimal"), { status: 400 });

  const neg = s.startsWith("-");
  const t = neg ? s.slice(1) : s;

  const [i, fRaw = ""] = t.split(".");
  const f = (fRaw + "0".repeat(scale)).slice(0, scale);

  const out = BigInt(i) * pow10(scale) + BigInt(f || "0");
  return neg ? -out : out;
}

function intToDecStr(x, scale) {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const base = pow10(scale);
  const i = a / base;
  const f = a % base;
  const fs = f.toString().padStart(scale, "0");
  return `${neg ? "-" : ""}${i.toString()}.${fs}`;
}

function divRound(numer, denom) {
  // half-up rounding for BigInt
  const q = numer / denom;
  const r = numer % denom;
  if (r === 0n) return q;
  return r * 2n >= denom ? q + 1n : q;
}

/**
 * Compute gross quote (cents) = round(qty(1e10) * price(1e8) * 100 / 1e18)
 * Here we accept already-parsed ints to avoid double parsing.
 */
function computeGrossCentsFromInts(qtyInt1e10, priceInt1e8) {
  const numer = qtyInt1e10 * priceInt1e8 * 100n;
  const denom = 10n ** 18n;
  return divRound(numer, denom);
}

function assertNonEmpty(v, msg) {
  if (!String(v || "").trim()) throw Object.assign(new Error(msg), { status: 400 });
}

async function getWalletForUpdate(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT id, user_id, balance, status, currency
     FROM wallets
     WHERE user_id = :userId
     FOR UPDATE`,
    { userId }
  );
  if (!rows.length) throw Object.assign(new Error("Wallet not found"), { status: 404 });
  return rows[0];
}

async function getWalletSnapshot(conn, userId) {
  const [rows] = await conn.execute(
    `SELECT balance, currency, status
     FROM wallets
     WHERE user_id = :userId
     LIMIT 1`,
    { userId }
  );
  return rows[0] || null;
}

async function getHoldingForUpdate(conn, userId, symbol) {
  const [rows] = await conn.execute(
    `SELECT id, user_id, symbol, quantity, avg_cost
     FROM portfolio_holdings
     WHERE user_id = :userId AND symbol = :symbol
     FOR UPDATE`,
    { userId, symbol }
  );
  return rows[0] || null;
}

async function getHoldingSnapshot(conn, userId, symbol) {
  const [rows] = await conn.execute(
    `SELECT user_id, symbol, quantity, avg_cost
     FROM portfolio_holdings
     WHERE user_id = :userId AND symbol = :symbol
     LIMIT 1`,
    { userId, symbol }
  );
  return rows[0] || null;
}

async function insertWalletTx(conn, { userId, type, amountStr2dp, newBalanceStr2dp, description, referenceId, actorUserId }) {
  const [r] = await conn.execute(
    `INSERT INTO wallet_transactions
      (user_id, type, amount, balance_after, description, reference_id, status, actor_user_id)
     VALUES
      (:userId, :type, :amount, :balanceAfter, :description, :referenceId, 'CONFIRMED', :actorUserId)`,
    {
      userId,
      type,
      amount: amountStr2dp,
      balanceAfter: newBalanceStr2dp,
      description,
      referenceId,
      actorUserId,
    }
  );
  return r.insertId;
}

async function upsertHoldingBuy(conn, { userId, symbol, buyQty, buyPrice }) {
  const row = await getHoldingForUpdate(conn, userId, symbol);

  const buyQtyInt = parseDecToInt(buyQty, 10);
  const buyPriceInt = parseDecToInt(buyPrice, 8);

  if (!row) {
    await conn.execute(
      `INSERT INTO portfolio_holdings (user_id, symbol, quantity, avg_cost)
       VALUES (:userId, :symbol, :qty, :avg)`,
      {
        userId,
        symbol,
        qty: intToDecStr(buyQtyInt, 10),
        avg: intToDecStr(buyPriceInt, 8),
      }
    );
    return { quantity: intToDecStr(buyQtyInt, 10), avg_cost: intToDecStr(buyPriceInt, 8) };
  }

  const oldQtyInt = parseDecToInt(row.quantity, 10);
  const oldAvgInt = parseDecToInt(row.avg_cost, 8);

  const newQtyInt = oldQtyInt + buyQtyInt;

  // newAvg = (oldQty*oldAvg + buyQty*buyPrice) / newQty  (scales: (10+8)=18 over 10 => 8)
  const oldCostInt = oldQtyInt * oldAvgInt; // scale 18
  const buyCostInt = buyQtyInt * buyPriceInt; // scale 18
  const newCostInt = oldCostInt + buyCostInt; // scale 18

  const newAvgInt = divRound(newCostInt, newQtyInt); // => scale 8

  await conn.execute(
    `UPDATE portfolio_holdings
     SET quantity = :qty, avg_cost = :avg
     WHERE id = :id`,
    {
      id: row.id,
      qty: intToDecStr(newQtyInt, 10),
      avg: intToDecStr(newAvgInt, 8),
    }
  );

  return { quantity: intToDecStr(newQtyInt, 10), avg_cost: intToDecStr(newAvgInt, 8) };
}

async function updateHoldingSell(conn, { userId, symbol, sellQty }) {
  const row = await getHoldingForUpdate(conn, userId, symbol);
  if (!row) throw Object.assign(new Error("No holdings for this symbol"), { status: 400 });

  const oldQtyInt = parseDecToInt(row.quantity, 10);
  const sellQtyInt = parseDecToInt(sellQty, 10);

  if (sellQtyInt > oldQtyInt) throw Object.assign(new Error("Insufficient holdings quantity"), { status: 400 });

  const newQtyInt = oldQtyInt - sellQtyInt;

  // Keep avg_cost unchanged for partial sells; reset to 0 if position closed
  const newAvgInt = newQtyInt === 0n ? 0n : parseDecToInt(row.avg_cost, 8);

  await conn.execute(
    `UPDATE portfolio_holdings
     SET quantity = :qty, avg_cost = :avg
     WHERE id = :id`,
    {
      id: row.id,
      qty: intToDecStr(newQtyInt, 10),
      avg: intToDecStr(newAvgInt, 8),
    }
  );

  return { quantity: intToDecStr(newQtyInt, 10), avg_cost: intToDecStr(newAvgInt, 8) };
}

async function findExistingTrade(conn, userId, referenceId) {
  const [rows] = await conn.execute(
    `SELECT *
     FROM trade_fills
     WHERE user_id = :userId AND reference_id = :referenceId
     LIMIT 1`,
    { userId, referenceId }
  );
  return rows[0] || null;
}

async function insertTradeFill(conn, row) {
  const [r] = await conn.execute(
    `INSERT INTO trade_fills
      (user_id, side, symbol, qty, price, gross_quote, fee_quote, net_quote, wallet_tx_id, reference_id, request_id, status)
     VALUES
      (:userId, :side, :symbol, :qty, :price, :gross, :fee, :net, :walletTxId, :referenceId, :requestId, 'FILLED')`,
    row
  );
  return r.insertId;
}

function normalizeResponse({ trade, walletTxId, walletSnapshot, positionSnapshot, idempotent }) {
  const balance = walletSnapshot?.balance ?? null;
  const currency = walletSnapshot?.currency ?? null;

  return {
    trade,
    tradeId: trade?.id ?? null,

    // These are the critical aliases for your receipt demo scripts:
    walletTxId: walletTxId ?? null,
    txId: walletTxId ?? null,

    wallet: walletSnapshot ? { balance, currency, status: walletSnapshot.status } : undefined,
    newBalance: balance, // alias

    position: positionSnapshot
      ? { quantity: positionSnapshot.quantity, avg_cost: positionSnapshot.avg_cost, symbol: positionSnapshot.symbol }
      : undefined,

    idempotent: !!idempotent,
  };
}

async function buy({ userId, symbol, qty, price, fee, referenceId, requestId }) {
  assertNonEmpty(symbol, "symbol is required");
  assertNonEmpty(referenceId, "referenceId is required");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Idempotency first
    const existing = await findExistingTrade(conn, userId, referenceId);
    if (existing) {
      const walletTxId = existing.wallet_tx_id ?? null;
      const walletSnap = await getWalletSnapshot(conn, userId);
      const posSnap = await getHoldingSnapshot(conn, userId, symbol);

      await conn.commit();
      logger.info({ userId, symbol, referenceId, tradeId: existing.id, walletTxId }, "trade_buy_idempotent");

      return normalizeResponse({
        trade: existing,
        walletTxId,
        walletSnapshot: walletSnap,
        positionSnapshot: posSnap,
        idempotent: true,
      });
    }

    // Strong input validation (BigInt-safe)
    const qtyInt = parseDecToInt(qty, 10);
    const priceInt = parseDecToInt(price, 8);
    const feeCents = parseDecToInt(fee ?? 0, 2);

    if (qtyInt <= 0n) throw Object.assign(new Error("qty must be > 0"), { status: 400 });
    if (priceInt <= 0n) throw Object.assign(new Error("price must be > 0"), { status: 400 });
    if (feeCents < 0n) throw Object.assign(new Error("fee must be >= 0"), { status: 400 });

    const wallet = await getWalletForUpdate(conn, userId);
    if (wallet.status !== "ACTIVE") throw Object.assign(new Error("Wallet is not ACTIVE"), { status: 403 });

    const grossCents = computeGrossCentsFromInts(qtyInt, priceInt);
    const totalDebitCents = grossCents + feeCents;

    const balanceCents = parseDecToInt(wallet.balance, 2);
    if (balanceCents < totalDebitCents) throw Object.assign(new Error("Insufficient wallet balance"), { status: 400 });

    const newBalCents = balanceCents - totalDebitCents;
    const newBalanceStr = intToDecStr(newBalCents, 2);

    await conn.execute(`UPDATE wallets SET balance = :bal WHERE id = :id`, { bal: newBalanceStr, id: wallet.id });

    const walletRef = `TRD:${referenceId}`;
    const amountStr = intToDecStr(-totalDebitCents, 2);
    const desc = `BUY ${symbol} qty=${qty} price=${price} fee=${fee ?? 0}`;

    const walletTxId = await insertWalletTx(conn, {
      userId,
      type: "BUY",
      amountStr2dp: amountStr,
      newBalanceStr2dp: newBalanceStr,
      description: desc,
      referenceId: walletRef,
      actorUserId: userId,
    });

    const pos = await upsertHoldingBuy(conn, { userId, symbol, buyQty: qty, buyPrice: price });

    const tradeId = await insertTradeFill(conn, {
      userId,
      side: "BUY",
      symbol,
      qty,
      price,
      gross: intToDecStr(grossCents, 2),
      fee: intToDecStr(feeCents, 2),
      net: intToDecStr(-totalDebitCents, 2),
      walletTxId,
      referenceId,
      requestId: requestId || null,
    });

    const [rows] = await conn.execute(`SELECT * FROM trade_fills WHERE id = :id`, { id: tradeId });
    const trade = rows[0];

    const walletSnap = { balance: newBalanceStr, currency: wallet.currency, status: wallet.status };
    const posSnap = await getHoldingSnapshot(conn, userId, symbol);

    await conn.commit();
    logger.info({ userId, symbol, referenceId, tradeId, walletTxId }, "trade_buy_filled");

    return normalizeResponse({
      trade,
      walletTxId,
      walletSnapshot: walletSnap,
      positionSnapshot: posSnap,
      idempotent: false,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function sell({ userId, symbol, qty, price, fee, referenceId, requestId }) {
  assertNonEmpty(symbol, "symbol is required");
  assertNonEmpty(referenceId, "referenceId is required");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Idempotency first
    const existing = await findExistingTrade(conn, userId, referenceId);
    if (existing) {
      const walletTxId = existing.wallet_tx_id ?? null;
      const walletSnap = await getWalletSnapshot(conn, userId);
      const posSnap = await getHoldingSnapshot(conn, userId, symbol);

      await conn.commit();
      logger.info({ userId, symbol, referenceId, tradeId: existing.id, walletTxId }, "trade_sell_idempotent");

      return normalizeResponse({
        trade: existing,
        walletTxId,
        walletSnapshot: walletSnap,
        positionSnapshot: posSnap,
        idempotent: true,
      });
    }

    // Strong input validation (BigInt-safe)
    const qtyInt = parseDecToInt(qty, 10);
    const priceInt = parseDecToInt(price, 8);
    const feeCents = parseDecToInt(fee ?? 0, 2);

    if (qtyInt <= 0n) throw Object.assign(new Error("qty must be > 0"), { status: 400 });
    if (priceInt <= 0n) throw Object.assign(new Error("price must be > 0"), { status: 400 });
    if (feeCents < 0n) throw Object.assign(new Error("fee must be >= 0"), { status: 400 });

    const wallet = await getWalletForUpdate(conn, userId);
    if (wallet.status !== "ACTIVE") throw Object.assign(new Error("Wallet is not ACTIVE"), { status: 403 });

    // Position update first (locks holdings row)
    await updateHoldingSell(conn, { userId, symbol, sellQty: qty });

    const grossCents = computeGrossCentsFromInts(qtyInt, priceInt);
    if (feeCents > grossCents) throw Object.assign(new Error("Fee exceeds gross"), { status: 400 });

    const netCreditCents = grossCents - feeCents;

    const balanceCents = parseDecToInt(wallet.balance, 2);
    const newBalCents = balanceCents + netCreditCents;
    const newBalanceStr = intToDecStr(newBalCents, 2);

    await conn.execute(`UPDATE wallets SET balance = :bal WHERE id = :id`, { bal: newBalanceStr, id: wallet.id });

    const walletRef = `TRD:${referenceId}`;
    const amountStr = intToDecStr(netCreditCents, 2);
    const desc = `SELL ${symbol} qty=${qty} price=${price} fee=${fee ?? 0}`;

    const walletTxId = await insertWalletTx(conn, {
      userId,
      type: "SELL",
      amountStr2dp: amountStr,
      newBalanceStr2dp: newBalanceStr,
      description: desc,
      referenceId: walletRef,
      actorUserId: userId,
    });

    const tradeId = await insertTradeFill(conn, {
      userId,
      side: "SELL",
      symbol,
      qty,
      price,
      gross: intToDecStr(grossCents, 2),
      fee: intToDecStr(feeCents, 2),
      net: intToDecStr(netCreditCents, 2),
      walletTxId,
      referenceId,
      requestId: requestId || null,
    });

    const [rows] = await conn.execute(`SELECT * FROM trade_fills WHERE id = :id`, { id: tradeId });
    const trade = rows[0];

    const walletSnap = { balance: newBalanceStr, currency: wallet.currency, status: wallet.status };
    const posSnap = await getHoldingSnapshot(conn, userId, symbol);

    await conn.commit();
    logger.info({ userId, symbol, referenceId, tradeId, walletTxId }, "trade_sell_filled");

    return normalizeResponse({
      trade,
      walletTxId,
      walletSnapshot: walletSnap,
      positionSnapshot: posSnap,
      idempotent: false,
    });
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
 
async function getFillByReference({ userId, referenceId }) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT
         id, user_id, symbol, side, qty, price, gross_quote, fee_quote, net_quote,
         status, reference_id, created_at,
         ledger_block_height, ledger_item_idx, ledger_commit_key, ledger_committed_at
       FROM trade_fills
       WHERE user_id = :userId AND reference_id = :referenceId
       LIMIT 1`,
      { userId, referenceId }
    );
    return rows[0] || null;
  } finally {
    conn.release();
  }
}

async function getFillById({ userId, id }) {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.execute(
      `SELECT
         id, user_id, symbol, side, qty, price, gross_quote, fee_quote, net_quote,
         status, reference_id, created_at,
         ledger_block_height, ledger_item_idx, ledger_commit_key, ledger_committed_at
       FROM trade_fills
       WHERE user_id = :userId AND id = :id
       LIMIT 1`,
      { userId, id }
    );
    return rows[0] || null;
  } finally {
    conn.release();
  }
}


async function listFills({ userId, limit = 50, cursorId = null, symbol = null, side = null, maxLimit = 500 }) {
  const conn = await pool.getConnection();
  try {
    const lim = Math.max(1, Math.min(maxLimit, Number(limit) || 50));

    const params = { userId };
    let where = "WHERE user_id = :userId";

    if (cursorId != null) {
      params.cursorId = Number(cursorId);
      where += " AND id < :cursorId";
    }
    if (symbol) {
      params.symbol = String(symbol).toUpperCase();
      where += " AND symbol = :symbol";
    }
    if (side) {
      params.side = String(side).toUpperCase();
      where += " AND side = :side";
    }

    // IMPORTANT: include wallet + ledger pointer columns so Person C can sync them into Mongo
    const sql = `
      SELECT
        id, user_id, symbol, side, qty, price, gross_quote, fee_quote, net_quote,
        status, reference_id, created_at,
        wallet_tx_id,
        ledger_block_height, ledger_item_idx, ledger_commit_key, ledger_committed_at
      FROM trade_fills
      ${where}
      ORDER BY id DESC
      LIMIT ${lim}
    `;

    const [rows] = await conn.query(sql, params);

    const nextCursorId = rows.length ? rows[rows.length - 1].id : null;
    return { rows, nextCursorId };
  } finally {
    conn.release();
  }
}



async function getFillByReferenceInternal({ userId, referenceId }) {
  return getFillByReference({ userId, referenceId });
}

async function listFillsInternal({ userId, limit = 200, cursorId = null }) {
  return listFills({
    userId,
    limit: Number(limit) || 200,
    cursorId,          // must be cursorId (not cursorId typo)
    maxLimit: 500,
  });
}


module.exports = {
  tradeService: {
    buy,
    sell,
    getFillByReference,
    getFillById,
    listFills,
    getFillByReferenceInternal,
    listFillsInternal,
  },
};

