const Candle = require("../models/candle");
const { calculateDailyReturns } = require("../utils/riskEngine");
const { pearsonCorrelation } = require("../utils/correlation");

async function computeCorrelationMatrix(symbols, lookbackDays = 90) {
  const returnsMap = {};

  for (const symbol of symbols) {
    const candles = await Candle.find({
      symbol,
      interval: "1d"
    }).sort({ timestamp: 1 });

    if (candles.length < 2) continue;

    returnsMap[symbol] = calculateDailyReturns(candles);
  }

  const matrix = {};

  for (const a of symbols) {
    matrix[a] = {};

    for (const b of symbols) {
      if (a === b) continue;

      const rA = returnsMap[a];
      const rB = returnsMap[b];
      if (!rA || !rB) continue;

      const len = Math.min(rA.length, rB.length);
      matrix[a][b] = Number(
        pearsonCorrelation(
          rA.slice(-len),
          rB.slice(-len)
        ).toFixed(3)
      );
    }
  }

  return matrix;
}

module.exports = { computeCorrelationMatrix };
