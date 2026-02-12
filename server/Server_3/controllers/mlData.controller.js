const Candle = require("../models/candle");

/* ===============================
   Utilities
================================ */

/* interval → milliseconds */
function intervalToMs(interval) {
  switch (interval) {
    case "1h": return 60 * 60 * 1000;
    case "1d": return 24 * 60 * 60 * 1000;
    default: return 0;
  }
}

/* candles per day */
function getCandlesPerDay(interval) {
  return {
    "1d": 1,
    "12h": 2,
    "1h": 24,
    "30m": 48,
    "15m": 96,
    "5m": 288
  }[interval];
}

/* ===============================
   Feature helpers
================================ */

function calculateReturns(candles) {
  return candles.map((_, i) => {
    if (i === 0) return null;
    return (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
  });
}

function calculateMovingAverage(candles, window) {
  return candles.map((_, i) => {
    if (i < window) return null;
    const slice = candles.slice(i - window, i);
    return slice.reduce((s, c) => s + c.close, 0) / slice.length;
  });
}

function calculateVolatility(returns, window) {
  return returns.map((_, i) => {
    if (i < window || returns[i] === null) return null;
    const slice = returns.slice(i - window, i).filter(r => r !== null);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const variance =
      slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / slice.length;
    return Math.sqrt(variance);
  });
}

function calculateMomentum(candles, window) {
  return candles.map((_, i) => {
    if (i < window) return null;
    return candles[i].close - candles[i - window].close;
  });
}

function calculateVolumeRatio(candles, window) {
  return candles.map((c, i) => {
    if (i < window || !c.volume) return null;
    const slice = candles
      .slice(i - window, i)
      .map(x => x.volume)
      .filter(Boolean);

    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return avg === 0 ? null : c.volume / avg;
  });
}

/* =========================================================
   API-1: ML Candles Endpoint (raw OHLCV, batch-safe)
   GET /v1/ml/candles
========================================================= */
exports.getMlCandles = async (req, res) => {
  try {
    const { symbols, interval, from, to, limit = 500 } = req.query;

    if (!symbols || !interval) {
      return res.status(400).json({
        ok: false,
        message: "symbols and interval are required"
      });
    }

    if (!["1h", "1d"].includes(interval)) {
      return res.status(400).json({
        ok: false,
        message: "unsupported interval"
      });
    }

    const symbolList = symbols.split(",");
    const intervalMs = intervalToMs(interval);
    const items = [];

    for (const symbol of symbolList) {
      const query = { symbol, interval };

      if (from || to) {
        query.timestamp = {};
        if (from) query.timestamp.$gte = Number(from);
        if (to) query.timestamp.$lte = Number(to);
      }

      const candles = await Candle.find(query)
        .sort({ timestamp: -1 })
        .limit(Number(limit))
        .lean();

      for (const c of candles) {
        items.push({
          symbol: c.symbol,
          openTime: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: c.volume ?? 0,
          closeTime: c.timestamp + intervalMs - 1
        });
      }
    }

    return res.json({
      ok: true,
      interval,
      items
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      message: "Failed to fetch ML candles"
    });
  }
};

/* =========================================================
   API-2: Latest Feature Endpoint (engineered features)
   GET /v1/ml/features/latest
========================================================= */
exports.getLatestFeatures = async (req, res) => {
  try {
    const { symbols, interval, lookback = 240 } = req.query;

    if (!symbols || !interval) {
      return res.status(400).json({
        ok: false,
        message: "symbols and interval are required"
      });
    }

    const symbolList = symbols.split(",");

    /* ===============================
       Derive windows from lookback
       (industrial-grade ratios)
    =============================== */

    const L = Number(lookback);

    const clamp = (v, min = 5) => Math.max(Math.floor(v), min);

    const shortMAWindow = clamp(L * 0.2);   // short trend
    const longMAWindow  = clamp(L * 0.5);   // long trend
    const volWindow     = clamp(L * 0.3);   // recent risk
    const momWindow     = clamp(L * 0.2);   // recent push
    const volRWindow    = clamp(L * 0.3);   // volume anomaly

    const minRequired =
      Math.max(
        longMAWindow,
        volWindow,
        volRWindow
      ) + 1;

    const features = [];
    let asOfTime = null;

    /* ===============================
       Per-symbol feature extraction
    =============================== */

    for (const symbol of symbolList) {
      const raw = await Candle.find({ symbol, interval })
        .sort({ timestamp: -1 })     // latest first
        .limit(L)
        .lean();

      if (raw.length < minRequired) continue;

      const candles = raw.reverse(); // chronological order

      const ret  = calculateReturns(candles);
      const maS  = calculateMovingAverage(candles, shortMAWindow);
      const maL  = calculateMovingAverage(candles, longMAWindow);
      const vol  = calculateVolatility(ret, volWindow);
      const mom  = calculateMomentum(candles, momWindow);
      const volR = calculateVolumeRatio(candles, volRWindow);

      /* ===============================
         Pick latest fully-valid point
      =============================== */
      for (let i = candles.length - 1; i >= 0; i--) {
        if (
          ret[i]  !== null &&
          maS[i]  !== null &&
          maL[i]  !== null &&
          vol[i]  !== null &&
          mom[i]  !== null &&
          volR[i] !== null
        ) {
          features.push({
            symbol,
            x: {
              return: Number(ret[i].toFixed(6)),
              ma_short: Number(maS[i].toFixed(4)),
              ma_long: Number(maL[i].toFixed(4)),
              volatility: Number(vol[i].toFixed(6)),
              momentum: Number(mom[i].toFixed(4)),
              volume_ratio: Number(volR[i].toFixed(4))
            }
          });

          asOfTime = candles[i].timestamp;
          break;
        }
      }
    }

    return res.json({
      ok: true,
      interval,
      lookback: L,
      asOfTime,
      features
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      ok: false,
      message: "Failed to compute ML features"
    });
  }
};


const {
  computeMlInfluenceGraph
} = require("../services/mlInfluenceGraph.service");

exports.getMlInfluenceGraph = async (req, res) => {
  try {
    const {
      interval,
      window = 240
    } = req.query;

    if (!interval) {
      return res.status(400).json({
        ok: false,
        message: "interval are required"
      });
    }

    const symbolList = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "DOTUSDT",
  "LINKUSDT",
  "MATICUSDT",
  "LTCUSDT",
  "TRXUSDT",
  "ATOMUSDT",
  "UNIUSDT"
];

    const result = await computeMlInfluenceGraph({
      symbols: symbolList,
      interval,
      window: Number(window)
    });

    res.json({
      ok: true,
      interval,
      window: Number(window),
      asOfTime: result.asOfTime,
      edges: result.edges
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      message: "Failed to compute ML influence graph"
    });
  }
};
