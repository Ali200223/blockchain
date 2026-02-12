// src/routes/market.js
const express = require("express");
const ingestAllSymbols = require("../jobs/ingestDailyCandles");
const candle = require("../models/candle");
const {getlivedata, activateSymbol, getMarketSymbols, getCandles, getSummary, getAllSummaries} = require("../controllers/market.controller")
const router = express.Router();

router.post("/activate", activateSymbol);

router.get("/livedata", getlivedata);
router.get("/symbols", getMarketSymbols);
router.get("/candles", getCandles);
router.get("/summary", getSummary);
router.get("/summary/allcoins", getAllSummaries);

module.exports = router;
