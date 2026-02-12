const express = require("express");
const router = express.Router();

const authJwt = require("../middleware/authJwt");
const { posttrade, gettrades } = require("../controllers/trade.controller");

if (typeof authJwt !== "function") {
  throw new Error(
    `authMiddleware must be a function. Got: ${typeof authJwt}. Check ../middleware/authJwt export.`
  );
}
router.use(authJwt);


router.post("/execute_trade", posttrade);
router.get("/get_trades", gettrades);

module.exports = router;
