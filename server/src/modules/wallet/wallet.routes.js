const router = require("express").Router();
const { authJwt } = require("../../middlewares/authJwt");
const controller = require("./wallet.controller");

router.get("/me", authJwt, controller.me);
router.get("/balance", authJwt, controller.balance); // alias for Person C compatibility
router.get("/transactions", authJwt, controller.myTransactions);

router.post("/deposit", authJwt, controller.deposit);
router.post("/withdraw", authJwt, controller.withdraw);

// Bank details
router.get("/bank", authJwt, controller.getBank);
router.post("/bank", authJwt, controller.saveBank);

// Admin adjust
router.post("/admin/adjust", authJwt, controller.adminAdjust);

module.exports = router;
