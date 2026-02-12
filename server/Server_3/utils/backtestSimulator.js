
function simulateBacktest(data, signals, initialCapital) {
  let cash = initialCapital;     // available cash
  let positionQty = 0;           // asset units held
  let equityCurve = [];          // portfolio value over time
  let trades = [];               // executed trades

  let signalIndex = 0;           // pointer to signals array

  for (let i = 0; i < data.length; i++) {
    const candle = data[i];

    // Check if a signal exists at this timestamp
    if (
      signalIndex < signals.length &&
      new Date(signal[signalIndex].timestamp).getTime()=== new Date(candle.timestamp).getTime()
    ) {
      const signal = signals[signalIndex];

      // BUY logic
      if (signal.signal === "BUY" && cash > 0) {
        positionQty = cash / candle.close;

        trades.push({
          timestamp: candle.timestamp,
          side: "BUY",
          price: candle.close,
          quantity: positionQty
        });

        cash = 0;
      }

      // SELL logic
      if (signal.signal === "SELL" && positionQty > 0) {
        cash = positionQty * candle.close;

        trades.push({
          timestamp: candle.timestamp,
          side: "SELL",
          price: candle.close,
          quantity: positionQty
        });

        positionQty = 0;
      }

      signalIndex++;
    }

    // Calculate portfolio equity at this time
    const equity =
      cash + positionQty * candle.close;

    equityCurve.push({
      timestamp: candle.timestamp,
      equity
    });
  }

  return { equityCurve, trades };
}


function calculateMetrics(equityCurve, trades, initialCapital) {
  const finalEquity =
    equityCurve[equityCurve.length - 1].equity;

  // Total return
  const totalReturnPct =
    ((finalEquity - initialCapital) / initialCapital) * 100;

  // Maximum drawdown
  let peak = equityCurve[0].equity;
  let maxDrawdown = 0;

  for (const point of equityCurve) {
    if (point.equity > peak) {
      peak = point.equity;
    }

    const drawdown = (peak - point.equity) / peak;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  const tradesCount = trades.length;

  return {
    total_return_pct: totalReturnPct,
    max_drawdown_pct: maxDrawdown * 100,
    trades_count: tradesCount
  };
}

module.exports = {
  simulateBacktest,
  calculateMetrics
};
