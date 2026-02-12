const { Router } = require("express");
const rateLimit = require("express-rate-limit");
const { authJwt } = require("../../middlewares/authJwt");
const controller = require("./ml.controller");

const router = Router();

const mlLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/price-prediction", authJwt, mlLimiter, controller.pricePrediction);

// NEW: list prediction history for the logged-in user
router.get("/predictions", authJwt, mlLimiter, controller.listPredictions);

module.exports = router;
