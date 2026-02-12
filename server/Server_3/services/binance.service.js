const axios = require("axios");

async function fetchKlines(symbol, interval, limit) {
  const res = await axios.get(`https://api.binance.com/api/v3/klines`, {
    params: {
      symbol,
      interval,
      limit
    }
  });

  return res.data;
}

module.exports = fetchKlines;
