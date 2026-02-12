const express = require("express");
const router = express.Router();
const authJwt = require("../middleware/authJwt");

const {
  getRiskSummary,
  getRiskScenarios,
  getCorrelationMatrix,
  getShockPropagation,
  getNewsDrivenRisk
} = require("../controllers/portfolioRisk.controller");

router.use(authJwt);

router.get("/portfolio/risk/news", getNewsDrivenRisk);
router.get("/portfolio/risk/summary", getRiskSummary);
router.get("/portfolio/risk/scenarios", getRiskScenarios);
router.get("/portfolio/risk/correlation", getCorrelationMatrix);
router.get("/portfolio/risk/propagation",getShockPropagation);

module.exports = router;
