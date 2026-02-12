const https = require("https");
const { env } = require("../config/env");

// symbol -> { price: "123.45", at: 1700000000000 }
const cache = new Map();

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              return reject(new Error(`Binance HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

/**
 * Returns spot price as a decimal string (Binance /api/v3/ticker/price).
 * Example symbol: BTCUSDT
 */
async function getSpotPrice(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();

  // conservative allow-list for symbols
  if (!/^[A-Z0-9._-]{1,20}$/.test(sym)) {
    const err = new Error("Invalid symbol");
    err.status = 400;
    err.code = "SYMBOL_INVALID";
    throw err;
  }

  const ttl = env.BINANCE_PRICE_TTL_MS;
  const now = Date.now();
  const cached = cache.get(sym);
  if (cached && now - cached.at <= ttl) return cached.price;

  const url = `${env.BINANCE_API_BASE}/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`;
  const j = await httpGetJson(url);

  const price = String(j?.price || "").trim();
  if (!/^\d+(\.\d+)?$/.test(price)) {
    const err = new Error("Invalid Binance price payload");
    err.status = 502;
    err.code = "BINANCE_BAD_PAYLOAD";
    throw err;
  }

  cache.set(sym, { price, at: now });
  return price;
}

module.exports = { getSpotPrice };
