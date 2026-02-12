const candle = require("../models/candle");
const fetchKlines = require("../services/binance.service");

module.exports = async function ingestHourly(symbol, limit=1) {
    const klines = await fetchKlines(symbol, "1h", limit);

    //console.log(symbol, "klines:", klines.length);

    const operations = klines.map(
      ([openTime, open, high, low, close, volume]) => ({
        updateOne: {
          filter: { symbol,interval: "1h", timestamp: Number(openTime) },
          update: {
            $set: {
              symbol,
              interval: "1h",
              timestamp: Number(openTime),
              open: Number(open),
              high: Number(high),
              low: Number(low),
              close: Number(close),
              volume: Number(volume),
              source: "binance"
            }
          },
          upsert: true
        }
      })
    );

    //console.log("Operations:", operations.length);

    if (operations.length > 0) {
      await candle.collection.bulkWrite(operations, { ordered: false });

      const mongoose = require("mongoose");

      //console.log("Mongoose DB name:", mongoose.connection.db.databaseName);
      console.log("Collection via mongoose:", await candle.countDocuments());

      console.log(`Ingested ${symbol}`);
    }
  
};

