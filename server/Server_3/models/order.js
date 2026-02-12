const mongoose = require("mongoose");

const orderSchema = new mongoose.Schema(
  {
    // UUID string (Person A compatible)
    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    // Stable idempotency key used when calling Person A
    referenceId: {
      type: String,
      required: true,
      trim: true,
    },

    // Optional: group SL/TP orders as one bracket (cancel sibling on execution)
    ocoGroupId: {
      type: String,
      default: null,
      trim: true,
      index: true,
    },

    symbol: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      index: true,
    },

    side: {
      type: String,
      enum: ["BUY", "SELL"],
      required: true,
    },

    // STOP = stop-loss triggers, LIMIT = take-profit/limit entry
    orderType: {
      type: String,
      enum: ["LIMIT", "STOP"],
      required: true,
      index: true,
    },

    // Store as string for precision
    qty: {
      type: String,
      required: true,
      trim: true,
    },

    // Trigger price (LIMIT price or STOP price). String for precision.
    price: {
      type: String,
      required: true,
      trim: true,
    },

    // Executor lifecycle (industrial)
    status: {
      type: String,
      enum: ["PENDING", "PROCESSING", "EXECUTED", "CANCELLED", "FAILED"],
      default: "PENDING",
      index: true,
    },

    // Execution linkage (projection)
    fillId: {
      type: Number,
      default: null,
      index: true,
    },

    executedAt: {
      type: Date,
      default: null,
    },

    failureReason: {
      type: String,
      default: null,
      trim: true,
    },

    // Optional slippage guard when executing (recommended)
    expectedPrice: { type: String, default: null, trim: true },
    maxSlippageBps: { type: Number, default: 50 },

    createdAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: false }
);

// Uniqueness per user
orderSchema.index({ userId: 1, referenceId: 1 }, { unique: true });

// Fast executor queries
orderSchema.index({ status: 1, symbol: 1 });
orderSchema.index({ userId: 1, status: 1, symbol: 1 });

module.exports = mongoose.model("Order", orderSchema);
