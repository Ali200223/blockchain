const axios = require("axios");
const MarketSymbol = require("../models/marketSymbol");

const ENABLED_COINS = [
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

module.exports = async function loadMarketSymbols() {
  try {
    console.log("Loading market symbols from Binance...");

    const res = await axios.get(
      "https://api.binance.com/api/v3/exchangeInfo"
    );

    const symbols = res.data.symbols.filter(
      s => s.status === "TRADING" && s.quoteAsset === "USDT"
    );

    for (const s of symbols) {
      const isEnabled = ENABLED_COINS.includes(s.symbol);

      await MarketSymbol.updateOne(
        { symbol: s.symbol },
        {
          $setOnInsert: {
            symbol: s.symbol,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            enabled: isEnabled
          }
        },
        { upsert: true }
      );
    }

    console.log(
      `Loaded ${symbols.length} symbols, enabled ${ENABLED_COINS.length}`
    );
  } catch (err) {
    console.error("Failed to load market symbols:", err.message);
  }
};
