const candle = require("../models/candle");
const MarketSymbol = require("../models/marketSymbol");
const ingestDailyCandles = require("../jobs/ingestDailyCandles");
const ingestHourlyCandles = require("../jobs/ingestHourlyCandles");
const { getAllPrices } = require("../services/livePrice.service");
const fetchKlines = require("../services/binance.service");

exports.getlivedata = (req, res) => {
  const prices = getAllPrices();

  const response = Object.keys(prices).map(symbol => ({
    symbol,
    price: prices[symbol]
  }));

  res.json({
    source: "binance-websocket",
    updatedAt: new Date(),
    data: response
  });
};


exports.activateSymbol = async (req, res) => {
  try {
    const { symbol } = req.body;

    if (!symbol) {
      return res.status(400).json({ message: "symbol is required" });
    }

    // Check if symbol exists in MarketSymbol
    const marketSymbol = await MarketSymbol.findOne({ symbol });

    if (!marketSymbol) {
      return res.status(404).json({
        message: "Symbol not found in market symbols"
      });
    }

    // If already enabled → do nothing
    if (marketSymbol.enabled) {
      return res.json({
        message: `${symbol} already active`,
        alreadyActive: true
      });
    }

    // Enable symbol
    marketSymbol.enabled = true;
    await marketSymbol.save();

    // IMMEDIATE candle bootstrap
    await ingestDailyCandles(symbol, 365);
    await ingestHourlyCandles(symbol, 720);
    console.log(`Activated symbol ${symbol} and bootstrapped candles`);
    return res.json({
      message: `${symbol} activated and candles ready`,
      alreadyActive: false
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Failed to activate symbol"
    });
  }
};

exports.getMarketSymbols = async (req, res) => {
  const symbols = await MarketSymbol.find({})
    .sort({ symbol: 1 });

  res.json(symbols);
};

exports.getCandles = async (req, res) => {
  const intervalOptions = ["1h", "1d", "1m", "3m", "5m", "15m", "30m", "4h", "6h", "8h", "12h", "3d", "1w", "1M"];
  try {
    const { symbol,interval, from, to, limit = 500 } = req.query;

    if (!symbol) {
      return res.status(400).json({ message: "symbol is required" });
    }
    if (!interval || !intervalOptions.includes(interval)) {
      return res.status(400).json({ message: "No interval or invalid interval" });
    }

    const query = { symbol, interval };

    if (from || to) {
      query.timestamp = {};
      if (from) query.timestamp.$gte = Number(from);
      if (to) query.timestamp.$lte = Number(to);
    }
    if (
      (interval === "1h" && limit <= 720) ||
      (interval === "1d" && limit <= 365)
    ) {
      const candles = await candle.find(query)
        .sort({ timestamp: -1 })
        .limit(Number(limit));

      res.json(candles);
      //return;
    }else{
      const klines = await fetchKlines(symbol, interval, limit);

      const formatted = klines.map(
        ([openTime, open, high, low, close, volume]) => ({
          timestamp: openTime,
          open: Number(open),
          high: Number(high),
          low: Number(low),
          close: Number(close),
          volume: Number(volume)
        })
      );

      res.json(formatted);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch candles" });
  }
};


const axios = require("axios");

exports.getSummary = async (req, res) => {
  try {
    const { symbol } = req.query;

    if (!symbol) {
      return res.status(400).json({ message: "symbol is required" });
    }

    const binanceSymbol = symbol.toUpperCase();

    const response = await axios.get(
      "https://api.binance.com/api/v3/ticker/24hr",
      {
        params: { symbol: binanceSymbol },
        timeout: 5000
      }
    );

    const data = response.data;

    res.json({
      symbol: binanceSymbol,
      open: Number(data.openPrice),
      high: Number(data.highPrice),
      low: Number(data.lowPrice),
      close: Number(data.lastPrice),
      changePercent: Number(data.priceChangePercent),
      volume: Number(data.volume)
    });
  } catch (err) {
    console.error(err.response?.data || err.message);

    if (err.response?.status === 429) {
      return res.status(429).json({ message: "Binance rate limit exceeded" });
    }

    res.status(500).json({ message: "Failed to fetch market summary" });
  }
};

exports.getAllSummaries = async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.binance.com/api/v3/ticker/24hr",
      { timeout: 8000 }
    );

    const summaries = response.data
    .filter(item => item.symbol.endsWith("USDT"))
    .map(item => ({
      symbol: item.symbol,
      open: Number(item.openPrice),
      high: Number(item.highPrice),
      low: Number(item.lowPrice),
      close: Number(item.lastPrice),
      changePercent: Number(item.priceChangePercent),
      volume: Number(item.volume)
    }));

    res.json(summaries);
  } catch (err) {
    console.error(err.response?.data || err.message);

    if (err.response?.status === 429) {
      return res
        .status(429)
        .json({ message: "Binance rate limit exceeded" });
    }

    res.status(500).json({ message: "Failed to fetch market summaries" });
  }
};
