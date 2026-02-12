const WebSocket = require("ws");
const { setPrice } = require("./livePrice.service");
const MarketSymbol  = require("../models/marketSymbol");


function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function startBinanceLive() {
  const symbols = await MarketSymbol.find(
    {},
    { symbol: 1, _id: 0 }
  );

  if (!symbols.length) return;

  const batches = chunkArray(symbols, 20);

  batches.forEach((batch, index) => {
    const streams = batch
      .map(s => `${s.symbol.toLowerCase()}@miniTicker`)
      .join("/");

    const wsUrl = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    const ws = new WebSocket(wsUrl);

    ws.on("open", () => {
      console.log(`Binance WS batch ${index + 1} connected`);
    });

    ws.on("message", data => {
      const msg = JSON.parse(data.toString());
      const trade = msg.data;

      setPrice(
        trade.s.toUpperCase(),
        Number(trade.c)
      );
    });

    ws.on("error", err => {
      console.error(`WS batch ${index + 1} error:`, err.message);
    });

    ws.on("close", () => {
      console.warn(`WS batch ${index + 1} closed — reconnecting...`);
      setTimeout(() => startBinanceLive(), 5000);
    });
  });
}

module.exports = startBinanceLive;
