const { pearsonCorrelation } = require("../utils/correlation");
const Candle = require("../models/candle");
/* Compute returns from candles */
function computeReturns(candles) {
  const returns = [];
  for (let i = 1; i < candles.length; i++) {
    returns.push(
      (candles[i].close - candles[i - 1].close) /
      candles[i - 1].close
    );
  }
  return returns;
}




/*
  Builds an influence graph for ML:
  - interval-aware
  - rolling window
  - edge list output
*/
async function computeMlInfluenceGraph({
  symbols,
  interval,
  window = 240,
  minWeightLag0 = 0.2,
  minWeightLag1 = 0.08
}) {
  const returnsMap = {};
  let asOfTime = null;

  // 1️⃣ Load candles & compute returns
  for (const symbol of symbols) {
    const candles = await Candle.find({
      symbol,
      interval
    })
      .sort({ timestamp: -1 })
      .limit(window + 2) // +2 to safely support lag=1
      .lean();

    if (candles.length < window + 2) continue;

    const ordered = candles.reverse();
    returnsMap[symbol] = computeReturns(ordered);
    asOfTime = ordered[ordered.length - 1].timestamp;
  }

  const edges = [];

  // 2️⃣ Build edges for lag = 0 and lag = 1
  for (const src of symbols) {
    for (const dst of symbols) {
      if (src === dst) continue;
      if (!returnsMap[src] || !returnsMap[dst]) continue;

      const rSrc = returnsMap[src];
      const rDst = returnsMap[dst];

      /* ---------- lag = 0 ---------- */
      {
        const len = Math.min(rSrc.length, rDst.length);

        const weight = pearsonCorrelation(
          rSrc.slice(-len),
          rDst.slice(-len)
        );

        if (Math.abs(weight) >= minWeightLag0) {
          edges.push({
            src,
            dst,
            weight: Number(weight.toFixed(3)),
            lag: 0
          });
        }
      }

      /* ---------- lag = 1 (src leads dst) ---------- */
      {
        // rSrc[t-1] vs rDst[t]
        const len = Math.min(rSrc.length - 1, rDst.length);

        if (len > 1) {
          const weight = pearsonCorrelation(
            rSrc.slice(-(len + 1), -1), // drop last
            rDst.slice(-len)            // keep last
          );

          if (Math.abs(weight) >= minWeightLag1) {
            edges.push({
              src,
              dst,
              weight: Number(weight.toFixed(3)),
              lag: 1
            });
          }
        }
      }
    }
  }

  return {
    asOfTime,
    edges
  };
}

module.exports = { computeMlInfluenceGraph };
