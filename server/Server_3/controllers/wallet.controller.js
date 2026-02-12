const walletService = require("../services/wallet.service");
const db = require("../config/mysql");


exports.getBalance = async (req, res) => {
  try {
    const wallet = await walletService.getWallet(req.auth.userId);

    if (!wallet) {
      return res.status(404).json({
        message: "Wallet not found"
      });
    }

    res.json({
      balance: wallet.balance
    });
  } catch (err) {
    res.status(500).json({
      message: "Failed to fetch wallet balance"
    });
  }
};

exports.getTransactions = async (req, res) => {
  try {
    const [transactions] = await db.query(
      `SELECT 
         type,
         amount,
         balance_after,
         description,
         reference_id,
         created_at
       FROM v_user_wallet_transactions
       WHERE user_id = ?
       ORDER BY created_at DESC`,
      [req.auth.userId]
    );

    res.json(transactions);
  } catch (err) {
    res.status(500).json({
      message: "Failed to fetch wallet transactions"
    });
  }
};


exports.deposit = async (req, res) => {
  try {
    const { amount, source } = req.body;
    
    if (!amount || amount < 1) {
      return res.status(400).json({
        message: "Invalid deposit amount"
      });
    }

    const depositSource = source || "Unknown";

    const newBalance = await walletService.deposit(
      req.auth.userId,
      amount,
      depositSource
    );

    res.json({
      message: "Deposit successful",
      balance: newBalance
    });
  } catch (err) {
    res.status(500).json({
      message: "Deposit failed"
    });
  }
};


exports.withdraw = async (req, res) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1) {
      return res.status(400).json({
        message: "Invalid withdrawal amount"
      });
    }

    const newBalance = await walletService.withdraw(
      req.auth.userId,
      amount
    );

    res.json({
      message: "Withdraw successful",
      balance: newBalance
    });
  } catch (err) {
    if (err.message === "INSUFFICIENT_BALANCE") {
      return res.status(400).json({
        message: "Insufficient wallet balance"
      });
    }

    if (err.message === "NO_WITHDRAWAL_ACCOUNT") {
      return res.status(400).json({
        message: "No withdrawal bank account configured"
      });
    }

    res.status(500).json({
      message: "Withdraw failed"
    });
  }
};