const Trade = require("../models/trade");
const { getPrice } = require("../services/livePrice.service");

// Trade qty/price are stored as strings for precision. Always coerce explicitly
// before doing arithmetic to avoid string concatenation and NaN propagation.
function toNum(v, fallback = 0) {
  if (v == null) return fallback;
  // Support BSON Decimal128 (defensive)
  if (v && typeof v === "object" && v._bsontype === "Decimal128" && typeof v.toString === "function") {
    v = v.toString();
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function formatPrice(value) {
  if (value >= 1) return Number(value.toFixed(2));
  if (value >= 0.01) return Number(value.toFixed(4));
  return Number(value.toFixed(8));
}

function formatMoney(value) {
  if (Math.abs(value) >= 1) return Number(value.toFixed(2));
  if (Math.abs(value) >= 0.01) return Number(value.toFixed(4));
  return Number(value.toFixed(6));
}
exports.getPortfolio = async (req, res) => {
  try {
    const trades = await Trade.find({ userId: req.auth.userId });
    //console.log("Fetched trades:", trades.length);
    const positions = {};

    // 1️⃣ Aggregate trades
    for (const trade of trades) {
      if (!positions[trade.symbol]) {
        positions[trade.symbol] = {
          symbol: trade.symbol,
          buyQty: 0,
          buyValue: 0,
          sellQty: 0
        };
      }

      // Backward-compatible read: some older code used `quantity` while the schema uses `qty`
      const qty = toNum(trade.qty ?? trade.quantity, 0);
      const price = toNum(trade.price, 0);

      if (trade.side === "BUY") {
        positions[trade.symbol].buyQty += qty;
        positions[trade.symbol].buyValue += qty * price;
      }

      if (trade.side === "SELL") {
        positions[trade.symbol].sellQty += qty;
      }
    }
    //console.log(positions);
    let totalValue = 0;
    let totalPnL = 0;
    const portfolio = [];

    // 2️⃣ Compute metrics
    for (const symbol in positions) {
      const pos = positions[symbol];
      //console.log("Processing position:", symbol, pos);
      const netQty = pos.buyQty - pos.sellQty;

      if (netQty <= 0) continue;

      const avgBuyPrice = pos.buyValue / pos.buyQty;

      const currentPrice = toNum(getPrice(symbol), 0);

      if (!currentPrice) continue;

      //const currentPrice = latestPrice.close;
      const marketValue = netQty * currentPrice;
      const unrealizedPnL = (currentPrice - avgBuyPrice) * netQty;

      totalValue += marketValue;
      totalPnL += unrealizedPnL;

      portfolio.push({
        symbol,
        quantity: netQty,
        avgBuyPrice: formatPrice(avgBuyPrice),
        currentPrice,
        marketValue: formatMoney(marketValue),
        unrealizedPnL: formatMoney(unrealizedPnL)
      });
    }

    res.json({
      positions: portfolio,
      totalValue: formatMoney(totalValue),
      totalPnL: formatMoney(totalPnL)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Portfolio calculation failed" });
  }
};
