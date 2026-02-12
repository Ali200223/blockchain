const db = require("../config/mysql");


exports.getBankDetails = async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT 
         bank_name,
         account_number,
         ifsc_code,
         updated_at
       FROM withdrawal_accounts
       WHERE user_id = ?`,
      [req.auth.userId]
    );

    if (!rows.length) {
      return res.status(404).json({
        message: "No withdrawal bank account configured"
      });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to fetch bank details"
    });
  }
};

exports.saveBankDetails = async (req, res) => {
  try {
    const { bankName, accountNumber, ifsc } = req.body;

    if (!bankName || !accountNumber) {
      return res.status(400).json({
        message: "Bank name and account number are required"
      });
    }

    await db.query(
      `INSERT INTO withdrawal_accounts 
       (user_id, bank_name, account_number, ifsc_code)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         bank_name = VALUES(bank_name),
         account_number = VALUES(account_number),
         ifsc_code = VALUES(ifsc_code)`,
      [req.auth.userId, bankName, accountNumber, ifsc]
    );

    res.json({ message: "Bank details saved" });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to save bank details"
    });
  }
};
