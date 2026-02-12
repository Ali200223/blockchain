const fs = require("fs");
const Candle = require("../models/candle");
const connectDB = require("../config/mongodb");
const fetchKlines = require("./binance.service");
const MarketSymbol = require("../models/marketSymbol");
connectDB('mongodb://127.0.0.1:27017/Crypto_data');

/* =======================
   Helper functions
======================= */

// 1️⃣ Returns
function calculateReturns(candles) {
  return candles.map((c, i) => {
    if (i === 0) return null;
    return (candles[i].close - candles[i - 1].close) / candles[i - 1].close;
  });
}

// 2️⃣ Moving Average
function calculateMovingAverage(candles, window) {
  return candles.map((_, i) => {
    if (i < window) return null;
    const slice = candles.slice(i - window, i);
    const avg =
      slice.reduce((sum, c) => sum + c.close, 0) / slice.length;
    return avg;
  });
}

// 3️⃣ Volatility (rolling std of returns)
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

// 4️⃣ Momentum
function calculateMomentum(candles, window) {
  return candles.map((_, i) => {
    if (i < window) return null;
    return candles[i].close - candles[i - window].close;
  });
}

// 5️⃣ Volume Ratio
function calculateVolumeRatio(candles, window) {
  return candles.map((c, i) => {
    if (i < window || !c.volume) return null;

    const slice = candles
      .slice(i - window, i)
      .map(x => x.volume)
      .filter(v => v !== undefined && v !== null);

    if (slice.length === 0) return null;

    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    return avg === 0 ? null : c.volume / avg;
  });
}

/* =======================
   Main Dataset Builder
======================= */

function getLimitForInterval(interval) {
  const minutesPerDay = 1440;
  const days = 365;

  const intervalMinutesMap = {
    "1d": 1440,
    "12h": 720,
    "1h": 60,
    "30m": 30,
    "15m": 15,
    "5m": 5
  };

  const intervalMinutes = intervalMinutesMap[interval];

  if (!intervalMinutes) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  const totalMinutes = days * minutesPerDay;
  return Math.floor(totalMinutes / intervalMinutes);
}

function getCandlesPerDay(interval) {
  const map = {
    "1d": 1,
    "12h": 2,
    "1h": 24,
    "30m": 48,
    "15m": 96,
    "5m": 288
  };

  if (!map[interval]) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  return map[interval];
}


async function exportAllCoins(interval="1d") {
  const limit = getLimitForInterval(interval);
  const symbols = await MarketSymbol.find({},{ "symbol": 1, _id: 0 });

  const rows = [];
  const cpd = getCandlesPerDay(interval);
  for (const s of symbols) {
    const symbol = s.symbol;
    console.log(`Processing ${symbol}...`);
    const klines = await fetchKlines(symbol, interval, limit);

    const candles = klines
      .map(([openTime, open, high, low, close, volume]) => ({
        timestamp: openTime,
        open: Number(open),
        high: Number(high),
        low: Number(low),
        close: Number(close),
        volume: Number(volume)
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const ret = calculateReturns(candles);
    const maS = calculateMovingAverage(candles, 10*cpd);
    const maL = calculateMovingAverage(candles, 20*cpd);
    const vol = calculateVolatility(ret, 14*cpd);
    const mom = calculateMomentum(candles, 10*cpd);
    const volR = calculateVolumeRatio(candles, 20*cpd);
    for (let i = 0; i < candles.length - 1; i++) {
      if (
        ret[i] === null ||
        maS[i] === null ||
        maL[i] === null ||
        vol[i] === null ||
        mom[i] === null ||
        volR[i] === null
      ) continue;

      const label = candles[i + 1].close > candles[i].close ? 1 : 0;

      rows.push({
        timestamp: new Date(candles[i].timestamp).toISOString(),
        symbol,
        return: ret[i],
        ma_short: maS[i],
        ma_long: maL[i],
        volatility: vol[i],
        momentum: mom[i],
        volume_ratio: volR[i],
        label
      });
    }
  }

  const header =
    "timestamp,symbol,return,ma_short,ma_long,volatility,momentum,volume_ratio,label\n";

  const csv =
    header +
    rows.map(r =>
      `${r.timestamp},${r.symbol},${r.return.toFixed(6)},${r.ma_short.toFixed(4)},${r.ma_long.toFixed(4)},${r.volatility.toFixed(6)},${r.momentum.toFixed(4)},${r.volume_ratio.toFixed(4)},${r.label}`
    ).join("\n");

  const filename = `ml_dataset_all_coins_${interval}.csv`;

  fs.writeFileSync(filename, csv);
  console.log(
  `Dataset created: ${filename} (${rows.length} rows)`
);
}


module.exports = {
  exportAllCoins
};