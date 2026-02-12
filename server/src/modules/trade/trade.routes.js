const router = require("express").Router();
const { authJwt } = require("../../middlewares/authJwt");
const controller = require("./trade.controller");

const { reverseTradeFillController } = require("./tradeReversal.controller");

router.post("/buy", authJwt, controller.buy);
router.post("/sell", authJwt, controller.sell);

// New: market execution with authoritative Binance price
router.post("/execute", authJwt, controller.execute);

router.post("/fills/:id/reverse", authJwt, reverseTradeFillController);

router.get("/fills", authJwt, controller.listFills);
router.get("/fills/by-reference/:referenceId", authJwt, controller.getFillByReference);
router.get("/fills/:id", authJwt, controller.getFillById);


module.exports = router;
