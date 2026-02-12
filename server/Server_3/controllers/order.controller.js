// core_files/controllers/order.controller.js
const Order = require("../models/order");
const crypto = require("crypto");

function uuid() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

exports.postorder = async (req, res) => {
  try {
    const userId = req.auth.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const { symbol, side, orderType } = req.body || {};
    const qtyIn = req.body?.qty ?? req.body?.quantity;
    const priceIn = req.body?.price;

    if (!symbol || !side || !orderType || qtyIn == null || priceIn == null) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const S = String(symbol).toUpperCase().trim();
    const SIDE = String(side).toUpperCase().trim();
    const TYPE = String(orderType).toUpperCase().trim();
    const QTY = String(qtyIn).trim();
    const PRICE = String(priceIn).trim();

    if (!["BUY", "SELL"].includes(SIDE)) return res.status(400).json({ message: "Invalid side" });
    if (!["LIMIT", "STOP"].includes(TYPE)) return res.status(400).json({ message: "Invalid order type" });

    // Keep your rule: STOP only for SELL
    if (TYPE === "STOP" && SIDE !== "SELL") {
      return res.status(400).json({ message: "STOP orders are only allowed for SELL" });
    }

    if (!/^\d+(\.\d+)?$/.test(QTY) || Number(QTY) <= 0) return res.status(400).json({ message: "Invalid qty" });
    if (!/^\d+(\.\d+)?$/.test(PRICE) || Number(PRICE) <= 0) return res.status(400).json({ message: "Invalid price" });

    const order = await Order.create({
      userId,
      referenceId: uuid(),
      symbol: S,
      side: SIDE,
      orderType: TYPE,
      qty: QTY,
      price: PRICE,
      status: "PENDING",
      createdAt: new Date(),
      maxSlippageBps: 50,
    });

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Order creation failed" });
  }
};

exports.getorders = async (req, res) => {
  try {
    const userId = req.auth.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const orders = await Order.find({ userId, status: "PENDING" }).sort({ createdAt: -1 }).limit(500);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch orders" });
  }
};

exports.updateorder = async (req, res) => {
  try {
    const userId = req.auth.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const order = await Order.findOne({ _id: req.params.id, userId, status: "PENDING" });
    if (!order) return res.status(404).json({ message: "Order not found or not editable" });

    const qtyIn = req.body?.qty ?? req.body?.quantity;
    const priceIn = req.body?.price;

    if (qtyIn !== undefined) {
      const QTY = String(qtyIn).trim();
      if (!/^\d+(\.\d+)?$/.test(QTY) || Number(QTY) <= 0) return res.status(400).json({ message: "Invalid qty" });
      order.qty = QTY;
    }

    if (priceIn !== undefined) {
      const PRICE = String(priceIn).trim();
      if (!/^\d+(\.\d+)?$/.test(PRICE) || Number(PRICE) <= 0) return res.status(400).json({ message: "Invalid price" });
      order.price = PRICE;
    }

    await order.save();
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: "Order update failed" });
  }
};

exports.deleteorder = async (req, res) => {
  try {
    const userId = req.auth.userId;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const order = await Order.findOne({ _id: req.params.id, userId, status: "PENDING" });
    if (!order) return res.status(404).json({ message: "Order not found or not cancellable" });

    order.status = "CANCELLED";
    order.failureReason = "cancelled_by_user";
    await order.save();

    res.json({ message: "Order cancelled" });
  } catch (err) {
    res.status(500).json({ message: "Order cancellation failed" });
  }
};
