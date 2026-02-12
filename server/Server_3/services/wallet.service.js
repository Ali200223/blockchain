const db = require("../config/mysql");

exports.getWallet = async (userId) => {
  const [rows] = await db.query(
    "SELECT balance FROM wallets WHERE user_id = ?",
    [userId]
  );
  return rows[0];
};

exports.addTransaction = async (
  userId,
  type,
  amount,
  balanceAfter,
  description,
  referenceId = null,
  status = "CONFIRMED"
) => {
  await db.query(
    `INSERT INTO wallet_transactions 
     (user_id, type, amount, balance_after, description, reference_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, type, amount, balanceAfter, description, referenceId, status]
  );
};


exports.deposit = async (userId, amount, source) => {
  const wallet = await exports.getWallet(userId);
  const newBalance = Number(wallet.balance) + amount;
  //console.log("balance after deposit:", newBalance);

  await db.query(
    "UPDATE wallets SET balance = ? WHERE user_id = ?",
    [newBalance, userId]
  );

  await exports.addTransaction(
    userId,
    "DEPOSIT",
    amount,
    newBalance,
    `Deposited via ${source}`
  );

  return newBalance;
};

exports.withdraw = async (userId, amount) => {
  const wallet = await exports.getWallet(userId);

  if (Number(wallet.balance) < amount) {
    throw new Error("INSUFFICIENT_BALANCE");
  }
  const [rows] = await db.query(
    "SELECT bank_name FROM withdrawal_accounts WHERE user_id = ?",
    [userId]
  );

  if (!rows.length) {
    throw new Error("NO_WITHDRAWAL_ACCOUNT");
  }

  const bankName = rows[0].bank_name;

  const newBalance = Number(wallet.balance) - amount;

  await db.query(
    "UPDATE wallets SET balance = ? WHERE user_id = ?",
    [newBalance, userId]
  );

  await exports.addTransaction(
    userId,
    "WITHDRAW",
    amount,
    newBalance,
    `Withdrawn to ${bankName}`
  );

  return newBalance;
};


exports.debitForBuy = async (userId, amount, quantity, symbol) => {
  const wallet = await exports.getWallet(userId);
  quantity = Number(quantity);
  if (Number(wallet.balance) < amount) {
    throw new Error("INSUFFICIENT_BALANCE");
  }

  const newBalance = Number(wallet.balance) - amount;
  await db.query(
    "UPDATE wallets SET balance = ? WHERE user_id = ?",
    [newBalance, userId]
  );

    const [result] = await db.query(
    `INSERT INTO wallet_transactions
     (user_id, type, amount, balance_after, description,status)
     VALUES (?, 'BUY', ?, ?, ?, 'PENDING')`,
    [
      userId,
      amount,
      newBalance,
      `Bought ${quantity} ${symbol}`
    ]
  );
  // RETURN wallet transaction ID
  return result.insertId;
};

exports.creditForSell = async (userId, amount, tradeId, quantity, symbol) => {
  const wallet = await exports.getWallet(userId);
  const newBalance = Number(wallet.balance) + amount;
  quantity = Number(quantity);
  await db.query(
    "UPDATE wallets SET balance = ? WHERE user_id = ?",
    [newBalance, userId]
  );

  await exports.addTransaction(userId,"SELL",amount,newBalance,`Sold ${quantity} ${symbol}`,tradeId);

  return newBalance;
};

exports.attachReferenceId = async (walletTxId, referenceId) => {
  await db.query(
    "UPDATE wallet_transactions SET reference_id = ?, status = ? WHERE id = ?",
    [referenceId, "CONFIRMED", walletTxId]
  );
};
exports.rollbackWalletTx = async (walletTxId, userId, amount) => {
  const wallet = await exports.getWallet(userId);
  const restoredBalance = Number(wallet.balance) + amount;

  // Restore balance
  await db.query(
    "UPDATE wallets SET balance = ? WHERE user_id = ?",
    [restoredBalance, userId]
  );

  // Mark transaction as reversed (NO DELETE)
  await db.query(
    "UPDATE wallet_transactions SET status = 'REVERSED' WHERE id = ?",
    [walletTxId]
  );
};
