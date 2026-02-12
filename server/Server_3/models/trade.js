const mongoose = require("mongoose");

const tradeSchema = new mongoose.Schema(
  {
    // Person A uses UUID user_id; store as string
    userId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },

    // Join key between Mongo trade and Person A fill
    referenceId: {
      type: String,
      required: true,
      trim: true,
    },

    // Person A identifiers (projection linkage)
    fillId: {
      type: Number,
      default: null,
      index: true,
    },
    walletTxId: {
      type: Number,
      default: null,
      index: true,
    },

    // Optional linkage back to Mongo order
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Order",
      default: null,
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

    // Use strings for precision (avoid float drift)
    qty: {
      type: String,
      required: true,
      trim: true,
    },

    // Execution price returned by Person A
    price: {
      type: String,
      required: true,
      trim: true,
    },

    // Quote fields from Person A (fee-safe)
    grossQuote: { type: String, default: null, trim: true },
    feeQuote: { type: String, default: null, trim: true },
    netQuote: { type: String, default: null, trim: true },

    // Mirrors Person A fill status (FILLED/REVERSED)
    status: {
      type: String,
      default: "FILLED",
      trim: true,
      index: true,
    },

    // Optional: ledger pointer fields (good for verification/audit display)
    ledgerBlockHeight: { type: Number, default: null },
    ledgerItemIdx: { type: Number, default: null },
    ledgerCommitKey: { type: String, default: null, trim: true },
    ledgerCommittedAt: { type: Date, default: null },

    source: {
      type: String,
      enum: ["MARKET", "ORDER_EXECUTOR"],
      default: "MARKET",
    },

    executedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: false }
);

// Uniqueness: a user cannot have two trades with the same referenceId
tradeSchema.index({ userId: 1, referenceId: 1 }, { unique: true });

// Useful listings
tradeSchema.index({ userId: 1, executedAt: -1 });
tradeSchema.index({ userId: 1, symbol: 1, executedAt: -1 });

module.exports = mongoose.model("Trade", tradeSchema);
