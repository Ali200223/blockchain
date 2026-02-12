// core_files/jobs/orderExecuter.js
const Order = require("../models/order");
const Trade = require("../models/trade");
const { getPrice } = require("../services/livePrice.service");
const { executeInternalTrade } = require("../services/personA.gateway");
const crypto = require("crypto");

const EXECUTION_INTERVAL = 15000; // 15 seconds
const SCAN_LIMIT = 100;

function uuid() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

function parseDecToInt(v, scale) {
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const [i, fRaw = ""] = s.split(".");
  const f = (fRaw + "0".repeat(scale)).slice(0, scale);
  return BigInt(i) * (10n ** BigInt(scale)) + BigInt(f || "0");
}

function shouldExecute(order, marketPriceStr) {
  const mp = parseDecToInt(marketPriceStr, 8);
  const op = parseDecToInt(order.price, 8);
  if (mp == null || op == null) return false;

  if (order.orderType === "LIMIT") {
    if (order.side === "BUY") return mp <= op;
    if (order.side === "SELL") return mp >= op;
  }

  if (order.orderType === "STOP") {
    // Your rule: STOP is only SELL
    if (order.side === "SELL") return mp <= op;
  }

  return false;
}

function mapFillToTradeDoc({ userId, referenceId, orderId, symbolFallback, sideFallback, qtyFallback, aResp }) {
  const t = aResp?.trade || {};
  return {
    userId,
    referenceId,
    orderId,

    fillId: aResp?.tradeId ?? t.id ?? null,
    walletTxId: aResp?.walletTxId ?? aResp?.txId ?? t.wallet_tx_id ?? null,

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

    source: "ORDER_EXECUTOR",
    executedAt: t.created_at ? new Date(t.created_at) : new Date(),
  };
}

async function markFailed(orderId, reason) {
  await Order.updateOne(
    { _id: orderId },
    { $set: { status: "FAILED", failureReason: String(reason || "failed"), executedAt: null } }
  );
}

async function markPending(orderId, reason) {
  await Order.updateOne(
    { _id: orderId },
    { $set: { status: "PENDING", failureReason: String(reason || "retry") } }
  );
}

async function markExecuted(orderId, fillId) {
  await Order.updateOne(
    { _id: orderId },
    { $set: { status: "EXECUTED", fillId: fillId ?? null, executedAt: new Date(), failureReason: null } }
  );
}

console.log("🟢 Order execution engine started (Person A settlement)...");

setInterval(async () => {
  try {
    // Optional “stuck processing” reset (uses createdAt as approximation)
    await Order.updateMany(
      {
        status: "PROCESSING",
        createdAt: { $lt: new Date(Date.now() - 10 * 60 * 1000) },
      },
      { $set: { status: "PENDING", failureReason: "stale_processing_reset" } }
    );

    const pending = await Order.find({ status: "PENDING" })
      .sort({ createdAt: 1 })
      .limit(SCAN_LIMIT)
      .lean();

    if (!pending.length) return;

    for (const o of pending) {
      const marketPrice = getPrice(o.symbol);
      if (!marketPrice) continue;

      if (!shouldExecute(o, String(marketPrice))) continue;

      // Claim atomically
      const claimed = await Order.findOneAndUpdate(
        { _id: o._id, status: "PENDING" },
        { $set: { status: "PROCESSING" } },
        { new: true }
      );

      if (!claimed) continue;

      // Ensure referenceId exists (for idempotency)
      if (!claimed.referenceId) {
        claimed.referenceId = uuid();
        await claimed.save();
      }

      const userId = String(claimed.userId);
      const symbol = String(claimed.symbol).toUpperCase();
      const side = String(claimed.side).toUpperCase();
      const qty = String(claimed.qty);

      try {
        const aResp = await executeInternalTrade({
          userId,
          symbol,
          side,
          qty,
          referenceId: claimed.referenceId,
          ...(claimed.expectedPrice ? {expectedPrice: claimed.expectedPrice } : {}),
          maxSlippageBps: claimed.maxSlippageBps ?? 50,
        });

        if (!aResp?.ok) {
          await markPending(claimed._id, "execution_failed_no_ok");
          continue;
        }

        // Upsert trade projection
        const tradeDoc = mapFillToTradeDoc({
          userId,
          referenceId: claimed.referenceId,
          orderId: claimed._id,
          symbolFallback: symbol,
          sideFallback: side,
          qtyFallback: qty,
          aResp,
        });

        await Trade.updateOne(
          { userId, referenceId: claimed.referenceId },
          { $set: tradeDoc },
          { upsert: true }
        );

        const fillId = aResp?.tradeId ?? aResp?.trade?.id ?? null;

        await markExecuted(claimed._id, fillId);

        // OCO cancellation (minimal)
        if (claimed.ocoGroupId) {
          await Order.updateMany(
            {
              userId,
              ocoGroupId: claimed.ocoGroupId,
              status: "PENDING",
              _id: { $ne: claimed._id },
            },
            { $set: { status: "CANCELLED", failureReason: "oco_sibling_executed" } }
          );
        }

        console.log(`✅ Executed order ${claimed._id} -> ${symbol} ${side} qty=${qty}`);
      } catch (err) {
        const status = err?.response?.status;
        const msg = err?.response?.data?.error || err?.response?.data?.message || err.message || "executor_error";

        // Business errors: do not retry forever
        if ([400, 401, 403, 404, 409].includes(status)) {
          await markFailed(claimed._id, msg);
        } else {
          // transient/network: return to pending for retry
          await markPending(claimed._id, `TEMP:${msg}`);
        }

        console.error(`❌ Order ${claimed._id} failed:`, msg);
      }
    }
  } catch (error) {
    console.error("❌ Order execution engine error:", error.message);
  }
}, EXECUTION_INTERVAL);
