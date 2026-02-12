const ingestDaily = require("./ingestDailyCandles");
const ingestHourly = require("./ingestHourlyCandles");
const MarketSymbol = require("../models/marketSymbol");
const  Candle = require("../models/candle")
module.exports = async function bootstrapCandles() {
  console.log("Bootstrapping candle data...");
  const symbols = await MarketSymbol.find(
      { enabled: true },
      { symbol: 1, _id: 0 }
  );
  for (const { symbol } of symbols) {
      await ingestDaily(symbol, 365);
      await ingestHourly(symbol,720);
  }
  await Candle.deleteMany({
      interval: "1h",
      timestamp: {
        $lt: Date.now() - 30 * 24 * 60 * 60 * 1000
      }
    });
    await Candle.deleteMany({
      interval: "1d",
      timestamp: {
        $lt: Date.now() - 365 * 24 * 60 * 60 * 1000
      }
    });
  console.log("Bootstrap complete");
};
