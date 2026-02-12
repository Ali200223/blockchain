const cron = require("node-cron");
const ingestDaily = require("./ingestDailyCandles");
const ingestHourly = require("./ingestHourlyCandles");
const MarketSymbol = require("../models/marketSymbol");
const Candle = require("../models/candle")

cron.schedule("0 * * * *", async () => {
  try {
    const symbols = await MarketSymbol.find(
      { enabled: true },
      { symbol: 1, _id: 0 }
    );

    for (const { symbol } of symbols) {
      await ingestHourly(symbol, 1);
    }

    await Candle.deleteMany({
      interval: "1h",
      timestamp: {
        $lt: Date.now() - 30 * 24 * 60 * 60 * 1000
      }
    });

    console.log("Hourly candles updated & cleaned");
  } catch (err) {
    console.error("Hourly cron failed:", err.message);
  }
});


cron.schedule("0 0 * * *", async () => {
  try {
    const symbols = await MarketSymbol.find(
      { enabled: true },
      { symbol: 1, _id: 0 }
    );

    for (const { symbol } of symbols) {
      await ingestDaily(symbol, 1);
    }

    await Candle.deleteMany({
      interval: "1d",
      timestamp: {
        $lt: Date.now() - 365 * 24 * 60 * 60 * 1000
      }
    });

    console.log("Daily candles updated & cleaned");
  } catch (err) {
    console.error("Daily cron failed:", err.message);
  }
});
