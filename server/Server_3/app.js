const express = require("express");
const cors = require("cors");
const startBinanceLive = require("./services/binanceLive.service");

const marketRoutes = require("./routes/market.routes");
const tradeRoutes = require("./routes/trade.routes");
const orderRoutes = require("./routes/order.routes");
const portfolioRoutes = require("./routes/portfolio.routes");
const bootstrapCandles = require("./jobs/bootstrapCandles");
const runInitialNewsFetch = require("./jobs/bootstrapNews");
const loadMarketSymbols = require("./jobs/loadMarketSymbols");
const watchlistRoutes = require("./routes/watchlist.routes");
const walletRoutes = require("./routes/wallet.routes");
const backtestRoutes = require("./routes/backtest.routes");
const mlRoutes = require("./routes/ml.routes");
const newsRoutes = require("./routes/news.routes");
const { startTradeResyncJob } = require("./jobs/tradeResync.job");


const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/news", newsRoutes);
app.use("/api/market", marketRoutes);
app.use("/v1/ml", mlRoutes);
app.use("/api/trades", tradeRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/portfolio", portfolioRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/wallet", walletRoutes);
app.use("/api/backtest", backtestRoutes);
app.use("/api", require("./routes/portfolioRisk.routes"));



app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

require("./jobs/orderExecuter");
require("./jobs/candleScheduler");
require("./jobs/newsScheduler");
(async () => {
  await loadMarketSymbols();
})();

startBinanceLive();
(async () => {
  try {
    await bootstrapCandles();
    console.log("Candle bootstrap completed");
  } catch (err) {
    console.error("Candle bootstrap failed:", err);
  }
})();


(async () => {
  try {
    await runInitialNewsFetch();
    console.log("News bootstrap completed");
  } catch (err) {
    console.error("News bootstrap failed:", err);
  }
})();
startTradeResyncJob();

module.exports = app;