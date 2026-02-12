const { pool } = require("../../config/mysql");

function toFiniteNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw Object.assign(new Error("Invalid amount"), { status: 400 });
  }
  return n;
}

// Keep 2dp to match DECIMAL(18,2) semantics
function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeDelta(type, amountRaw) {
  const typeNorm = String(type || "").toUpperCase();
  const a0 = toFiniteNumber(amountRaw);
  const a = round2(a0);

  if (!Number.isFinite(a)) {
    throw Object.assign(new Error("Invalid amount"), { status: 400 });
  }

  if (typeNorm === "DEPOSIT") {
    if (a <= 0) throw Object.assign(new Error("Invalid amount"), { status: 400 });
    return +a;
  }

  if (typeNorm === "WITHDRAW") {
    if (a <= 0) throw Object.assign(new Error("Invalid amount"), { status: 400 });
    return -a;
  }

  if (typeNorm === "ADJUST") {
    if (a === 0) throw Object.assign(new Error("Invalid amount"), { status: 400 });
    // ADJUST is a signed delta (can be + or -)
    return a;
  }

  throw Object.assign(new Error("Invalid type"), { status: 400 });
}

async function getWallet(userId) {
  const [rows] = await pool.execute(
    `SELECT user_id, balance, currency, status, updated_at
     FROM wallets
     WHERE user_id = :userId
     LIMIT 1`,
    { userId }
  );

  if (!rows.length) return null;
  return rows[0];
}

async function listMyTransactions(userId, limit = 50) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const [rows] = await pool.execute(
    `
    SELECT
      id,
      type,
      amount,
      balance_after,
      currency,
      description,
      reference_id,
      request_id,
      status,
      ledger_block_height,
      ledger_block_hash,
      ledger_commit_key,
      ledger_item_idx,
      ledger_committed_at,
      created_at
    FROM wallet_transactions
    WHERE user_id = :userId
    ORDER BY created_at DESC
    LIMIT ${lim}
    `,
    { userId }
  );
  return { limit: lim, items: rows };
}

async function getWithdrawalAccount(userId) {
  const [rows] = await pool.execute(
    `
    SELECT bank_name, account_number, iban, bic, ifsc_code, updated_at
    FROM withdrawal_accounts
    WHERE user_id = :userId
    LIMIT 1
    `,
    { userId }
  );
  return rows[0] || null;
}

async function upsertWithdrawalAccount({ userId, bankName, accountNumber, iban = null, bic = null, ifscCode = null }) {
  const bank = String(bankName || "").trim();
  const acct = String(accountNumber || "").trim();
  const ibanN = iban == null ? null : String(iban).trim() || null;
  const bicN = bic == null ? null : String(bic).trim() || null;
  const ifscN = ifscCode == null ? null : String(ifscCode).trim() || null;

  if (!bank || !acct) throw Object.assign(new Error("Invalid bank details"), { status: 400 });

  await pool.execute(
    `
    INSERT INTO withdrawal_accounts (user_id, bank_name, account_number, iban, bic, ifsc_code)
    VALUES (:userId, :bank, :acct, :iban, :bic, :ifsc)
    ON DUPLICATE KEY UPDATE
      bank_name = VALUES(bank_name),
      account_number = VALUES(account_number),
      iban = VALUES(iban),
      bic = VALUES(bic),
      ifsc_code = VALUES(ifsc_code),
      updated_at = CURRENT_TIMESTAMP
    `,
    { userId, bank, acct, iban: ibanN, bic: bicN, ifsc: ifscN }
  );

  return getWithdrawalAccount(userId);
}

async function findExistingTx(conn, { requestId, userId, referenceId }) {
  if (requestId) {
    const [rows] = await conn.execute(
      `
      SELECT id, balance_after, type, amount, reference_id, request_id, status, created_at
      FROM wallet_transactions
      WHERE request_id = :requestId
      LIMIT 1
      `,
      { requestId }
    );
    if (rows.length) return rows[0];
  }

  if (referenceId) {
    const [rows] = await conn.execute(
      `
      SELECT id, balance_after, type, amount, reference_id, request_id, status, created_at
      FROM wallet_transactions
      WHERE user_id = :userId AND reference_id = :referenceId
      LIMIT 1
      `,
      { userId, referenceId }
    );
    if (rows.length) return rows[0];
  }

  return null;
}

async function applyWalletTx(
  conn,
  {
    userId,
    type,
    amount,
    description,
    referenceId = null,
    meta = {},
  }
) {
  // Normalize inputs defensively
  const typeNorm = String(type || "").toUpperCase();
  const descNorm = String(description || "").trim();
  const refNorm =
    referenceId == null ? null : String(referenceId).trim() === "" ? null : String(referenceId).trim();

  const requestId = meta?.requestId ? String(meta.requestId).trim() : null;

  // Idempotency: request_id (preferred) then (user_id, reference_id)
  const existing = await findExistingTx(conn, {
    requestId: requestId || null,
    userId,
    referenceId: refNorm || null,
  });

  if (existing) {
    return {
      balance: Number(existing.balance_after),
      walletTxId: existing.id,
      idempotent: true,
      status: existing.status,
      note: "already_applied",
    };
  }

  // lock wallet row
  const [wRows] = await conn.execute(
    `SELECT balance, currency, status
     FROM wallets
     WHERE user_id = :userId
     FOR UPDATE`,
    { userId }
  );

  if (!wRows.length) throw Object.assign(new Error("Wallet not found"), { status: 404 });

  if (wRows[0].status !== "ACTIVE") {
    throw Object.assign(new Error("Wallet locked (KYC not approved)"), { status: 403 });
  }

  const currency = String(wRows[0].currency || "USDT");

  const oldBal = round2(toFiniteNumber(wRows[0].balance));
  const delta = computeDelta(typeNorm, amount);
  const newBal = round2(oldBal + delta);

  // STRICTEST RULE: never allow balance to go below 0 for any type
  if (newBal < 0) {
    throw Object.assign(new Error("Insufficient funds"), { status: 409 });
  }

  await conn.execute(
    `UPDATE wallets
     SET balance = :newBal
     WHERE user_id = :userId`,
    { userId, newBal }
  );

  const actorUserId = meta?.actorUserId ? String(meta.actorUserId) : null;
  const actorRole = meta?.actorRole ? String(meta.actorRole) : null;
  const actorIp = meta?.ip ? String(meta.ip) : null;
  const actorUserAgent = meta?.userAgent ? String(meta.userAgent) : null;
  const actorDeviceId = meta?.deviceId ? String(meta.deviceId) : null;

  // Insert tx (amount stored as signed delta)
  const [ins] = await conn.execute(
    `INSERT INTO wallet_transactions
      (user_id, type, amount, balance_after, currency, description, reference_id, request_id,
       actor_user_id, actor_role, actor_ip, actor_user_agent, actor_device_id, status)
     VALUES
      (:userId, :type, :amount, :balanceAfter, :currency, :desc, :refId, :requestId,
       :actorUserId, :actorRole, :actorIp, :actorUserAgent, :actorDeviceId, 'CONFIRMED')`,
    {
      userId,
      type: typeNorm,
      amount: delta,
      balanceAfter: newBal,
      currency,
      desc: descNorm,
      refId: refNorm,
      requestId: requestId || null,
      actorUserId,
      actorRole,
      actorIp,
      actorUserAgent,
      actorDeviceId,
    }
  );

  const walletTxId = ins.insertId;

  // Double-entry lines (optional but present in schema)
  try {
    await conn.execute(
      `
      INSERT INTO wallet_transaction_lines (tx_id, account, user_id, currency, delta)
      VALUES
        (:txId, 'USER_WALLET', :userId, :currency, :delta),
        (:txId, 'SYSTEM_CASH', NULL, :currency, :deltaOpp)
      `,
      { txId: walletTxId, userId, currency, delta, deltaOpp: -delta }
    );
  } catch (_) {
    // If table missing for older DB, do not fail wallet tx
  }

  return { balance: newBal, walletTxId, idempotent: false, status: "CONFIRMED" };
}

async function adjustWalletAtomic({ userId, type, amount, description, referenceId = null, meta = {} }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const out = await applyWalletTx(conn, {
      userId,
      type,
      amount,
      description,
      referenceId,
      meta,
    });

    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function depositAtomic({ userId, amount, source = "Unknown", referenceId = null, meta = {} }) {
  const desc = `Deposited via ${String(source || "Unknown").trim()}`;
  return adjustWalletAtomic({
    userId,
    type: "DEPOSIT",
    amount,
    description: desc,
    referenceId,
    meta,
  });
}

async function withdrawAtomic({ userId, amount, referenceId = null, meta = {} }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Require withdrawal account configured
    const [rows] = await conn.execute(
      `SELECT bank_name FROM withdrawal_accounts WHERE user_id = :userId LIMIT 1`,
      { userId }
    );
    if (!rows.length) throw Object.assign(new Error("No withdrawal bank account configured"), { status: 409 });

    const bankName = rows[0].bank_name;

    const out = await applyWalletTx(conn, {
      userId,
      type: "WITHDRAW",
      amount,
      description: `Withdrawn to ${bankName}`,
      referenceId,
      meta,
    });

    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  getWallet,
  listMyTransactions,
  getWithdrawalAccount,
  upsertWithdrawalAccount,
  applyWalletTx,
  adjustWalletAtomic,
  depositAtomic,
  withdrawAtomic,
};
