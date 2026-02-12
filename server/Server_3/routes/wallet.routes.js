const express = require("express");
const router = express.Router();
const auth = require("../middleware/authJwt");

const walletController = require("../controllers/wallet.controller");
//const walletService = require("../services/walletService");
const withdrawalBankContoller = require("../controllers/withdrawalBank.controller");

router.use(auth);

router.get("/balance", walletController.getBalance);
router.get("/transactions", walletController.getTransactions);
router.post("/deposit", walletController.deposit);
router.post("/withdraw", walletController.withdraw);

// 👇 Bank details
router.post("/bank", withdrawalBankContoller.saveBankDetails);
router.get("/bank", withdrawalBankContoller.getBankDetails);

module.exports = router;
