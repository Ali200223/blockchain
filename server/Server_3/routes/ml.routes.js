const express = require("express");
const router = express.Router();
const serviceKey = require("../middleware/serviceKey");

const {
  getMlCandles,getLatestFeatures, getMlInfluenceGraph
} = require("../controllers/mlData.controller");
router.use(serviceKey);

router.get("/candles", getMlCandles);
router.get("/latest_features", getLatestFeatures);
router.get("/influence_graph", getMlInfluenceGraph);
module.exports = router;
