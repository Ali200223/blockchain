// core_files/controllers/trade.controller.js
const Trade = require("../models/trade");
const { executeUserTrade } = require("../services/personA.gateway");
const crypto = require("crypto");

function uuid() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function mapFillToTradeDoc({ userId, referenceId, symbolFallback, sideFallback, qtyFallback, aResp, source, orderId }) {
  const t = aResp?.trade || {};
  return {
    userId,
    referenceId,

    fillId: aResp?.tradeId ?? t.id ?? null,
    walletTxId: aResp?.walletTxId ?? aResp?.txId ?? t.wallet_tx_id ?? null,

    orderId: orderId || null,

    symbol: (t.symbol || symbolFallback || "").toString().toUpperCase(),
    side: (t.side || sideFallback || "").toString().toUpperCase(),

    qty: String(t.qty ?? qtyFallback ?? ""),
    price: String(aResp?.executionPrice ?? t.price ?? ""),

    grossQuote: t.gross_quote ?? null,
    feeQuote: t.fee_quote ?? null,
    netQuote: t.net_quote ?? null,

    status: t.status ?? "FILLED",

    ledgerBlockHeight: t.ledger_block_height ?? null,
    ledgerItemIdx: t.ledger_item_idx ?? t.ledger_item_index ?? null,
    ledgerCommitKey: t.ledger_commit_key ?? null,
    ledgerCommittedAt: t.ledger_committed_at ? new Date(t.ledger_committed_at) : null,

    source: source || "MARKET",
    executedAt: t.created_at ? new Date(t.created_at) : new Date(),
  };
}

exports.posttrade = async (req, res) => {
  const userId = req.auth.userId;
  const token = req.auth?.token;

  try {
    const { symbol, side } = req.body || {};
    const quantity = req.body?.qty ?? req.body?.quantity;

    if (!userId) return res.status(401).json({ message: "Unauthorized" });
    if (!symbol || !side || quantity == null) return res.status(400).json({ message: "Missing fields" });

    const S = String(symbol).toUpperCase().trim();
    const SIDE = String(side).toUpperCase().trim();
    const QTY = String(quantity).trim();

    if (!["BUY", "SELL"].includes(SIDE)) return res.status(400).json({ message: "Invalid side" });
    if (!/^\d+(\.\d+)?$/.test(QTY) || Number(QTY) <= 0) return res.status(400).json({ message: "Invalid qty" });

    const referenceId = uuid();

    // Execute on Person A (authoritative settlement + price)
    const aResp = await executeUserTrade({
      token,
      symbol: S,
      side: SIDE,
      qty: QTY,
      referenceId,
      // optional: expectedPrice/maxSlippageBps can be set by frontend later
    });

    if (!aResp?.ok) {
      return res.status(502).json({ message: "Execution failed", details: aResp });
    }

    const doc = mapFillToTradeDoc({
      userId,
      referenceId,
      symbolFallback: S,
      sideFallback: SIDE,
      qtyFallback: QTY,
      aResp,
      source: "MARKET",
    });

    await Trade.updateOne({ userId, referenceId }, { $set: doc }, { upsert: true });
    const saved = await Trade.findOne({ userId, referenceId });

    return res.status(201).json(saved);
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.error || err?.response?.data?.message || err.message || "Trade execution failed";

    if (status) return res.status(status).json({ message: msg, details: err.response.data });
    return res.status(500).json({ message: msg });
  }
};

exports.gettrades = async (req, res) => {
  try {
    const userId = req.auth.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const trades = await Trade.find({ userId }).sort({ executedAt: -1 }).limit(500);
    res.json(trades);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch trades" });
  }
};
