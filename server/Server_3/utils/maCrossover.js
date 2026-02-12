function calculateMA(data, window) {
  const ma = [];

  for (let i = 0; i < data.length; i++) {
    if (i < window - 1) {
      ma.push(null); // not enough data
      continue;
    }

    let sum = 0;
    for (let j = i - window + 1; j <= i; j++) {
      sum += data[j].close;
    }

    ma.push(sum / window);
  }

  return ma;
}

function generateSignals(data, shortWindow, longWindow) {
  const shortMA = calculateMA(data, shortWindow);
  const longMA = calculateMA(data, longWindow);

  const signals = [];
  let position = null; // null or "LONG"

  for (let i = 1; i < data.length; i++) {
    if (
      shortMA[i - 1] === null ||
      longMA[i - 1] === null ||
      shortMA[i] === null ||
      longMA[i] === null
    ) {
      continue;
    }

    // BUY signal
    if (
      shortMA[i - 1] <= longMA[i - 1] &&
      shortMA[i] > longMA[i] &&
      position === null
    ) {
      signals.push({
        timestamp: data[i].timestamp,
        signal: "BUY",
        price: data[i].close
      });
      position = "LONG";
    }

    // SELL signal
    if (
      shortMA[i - 1] >= longMA[i - 1] &&
      shortMA[i] < longMA[i] &&
      position === "LONG"
    ) {
      signals.push({
        timestamp: data[i].timestamp,
        signal: "SELL",
        price: data[i].close
      });
      position = null;
    }
  }

  return signals;
}
module.exports = {generateSignals};