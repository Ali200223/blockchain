const Backtest = require("../models/backtest");
const Candle = require("../models/candle"); // your OHLCV model
const axios = require("axios");
const { generateSignals } = require("../utils/maCrossover");
const {
  simulateBacktest,
  calculateMetrics
} = require("../utils/backtestSimulator");
exports.postbacktest = async (req, res) => {
    const userId = req.auth.userId;
  try {
    const {
      symbol,
      interval,
      shortWindow,
      longWindow,
      startDate,
      endDate,
      initialCapital
    } = req.body;

    if (!initialCapital || initialCapital <= 0) {
      return res.status(400).json({
        message: "Initial capital must be greater than 0"
      });
    }
    if (!symbol || !interval) {
      return res.status(400).json({
        message: "Symbol and interval are required"
      });
    }

    if (!["1h", "1d"].includes(interval)) {
      return res.status(400).json({
        message: "Invalid interval"
      });
    }

    if (typeof shortWindow !== "number" || typeof longWindow !== "number") {
      return res.status(400).json({
        message: "MA windows must be numbers"
      });
    }

    if (shortWindow >= longWindow) {
      return res.status(400).json({
        message: "Short window must be smaller than long window"
      });
    }

    /* ===============================
       2. INTERVAL-BASED WINDOW LIMITS
    ================================ */

    if (interval === "1h" && (shortWindow > 30 || longWindow > 30)) {
      return res.status(400).json({
        message: "For 1h interval, MA windows must be ≤ 30"
      });
    }

    if (interval === "1d" && (shortWindow > 365 || longWindow > 365)) {
      return res.status(400).json({
        message: "For 1d interval, MA windows must be ≤ 365"
      });
    }

    const WINDOW_LIMITS = {
      "1h": 200,   // max reasonable MA for hourly
      "1d": 365    // max reasonable MA for daily
    };

    if (
      shortWindow > WINDOW_LIMITS[interval] ||
      longWindow > WINDOW_LIMITS[interval]
    ) {
      return res.status(400).json({
        message: "MA windows too large for ${interval} interval"
      });
    }
    const MIN_BUFFER = 5;

    

    const MAX_DIFF_MULTIPLIER = 4;

    if (longWindow - shortWindow > shortWindow * MAX_DIFF_MULTIPLIER) {
      return res.status(400).json({
        message: "MA window difference too large — strategy becomes unresponsive"
      });
    }
    /* ===============================
       3. DATE VALIDATION
    ================================ */

    const startTs = new Date(startDate).getTime();
    const endTs = new Date(endDate).getTime();

    if (isNaN(startTs) || isNaN(endTs)) {
      return res.status(400).json({
        message: "Invalid startDate or endDate"
      });
    }

    if (startTs >= endTs) {
      return res.status(400).json({
        message: "startDate must be before endDate"
      });
    }

    /* ===============================
       4. INTERVAL LOOKBACK CONSTRAINT
    ================================ */

    const NOW = Date.now();
    const LOOKBACK_LIMITS = {
      "1h": 30 * 24 * 60 * 60 * 1000,   // 30 days
      "1d": 365 * 24 * 60 * 60 * 1000  // 365 days
    };

    if (NOW - startTs > LOOKBACK_LIMITS[interval]) {
      return res.status(400).json({
        message: `For ${interval} interval, startDate must be within the last ${
          interval === "1h" ? "30 days" : "365 days"
        }`
      });
    }

    if (NOW - endTs > LOOKBACK_LIMITS[interval]) {
      return res.status(400).json({
        message: `For ${interval} interval, endDate must be within the last ${
          interval === "1h" ? "30 days" : "365 days"
        }`
      });
    }

    const MAX_LIMIT = 1000;

    let candles = [];
    let fetchFrom = startTs;

    while (true) {
      const res = await axios.get("https://api.binance.com/api/v3/klines", {
        params: {
          symbol: symbol.toUpperCase(),
          interval,
          startTime: fetchFrom,
          endTime: endTs,
          limit: MAX_LIMIT
        }
      });

      const data = res.data;
      if (!data.length) break;

      const batch = data.map(k => ({
        timestamp: new Date(k[0]),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5])
      }));

      candles.push(...batch);

      fetchFrom = data[data.length - 1][0] + 1;

      if (data.length < MAX_LIMIT) break;
    }

    if (!candles.length) {
      return res.status(400).json({
        message: "No historical data from Binance"
      });
    }
    if (candles.length < longWindow + MIN_BUFFER) {
      return res.status(400).json({
        message: `Not enough candles for MA strategy.
          Required ≥ ${longWindow + MIN_BUFFER},
          received ${candles.length}`
      });
    }
    // 2. Generate MA crossover signals
    const signals = generateSignals(
      candles,
      shortWindow,
      longWindow
    );

    // 3. Simulate trades
    const { equityCurve, trades } = simulateBacktest(
      candles,
      signals,
      initialCapital
    );

    // 4. Calculate metrics
    const metrics = calculateMetrics(
      equityCurve,
      trades,
      initialCapital
    );

    // 5. Save backtest result
    const backtest = await Backtest.create({
      user_id: userId,
      symbol,
      strategy: "ma_crossover",
      parameters: {
        short_window: shortWindow,
        long_window: longWindow,
        initial_capital: initialCapital
      },
      date_range: {
        start: startDate,
        end: endDate
      },
      metrics,
      equity_curve: equityCurve,
      trades
    });

    res.json(backtest);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      message: "Backtest execution failed"
    });
  }
};

exports.getbacktests = async (req, res) => {
  try {
    const backtests = await Backtest.find({
      user_id: req.auth.userId
    }).sort({ created_at: -1 });

    res.json(backtests);
  } catch (err) {
    res.status(500).json({
      message: "Failed to fetch backtests"
    });
  }
};