const mongoose = require("mongoose");

const candleSchema = new mongoose.Schema({
  symbol: { type: String, required: true },
  interval: {type: String,enum: ["1h", "1d"],required: true},
  timestamp: { type: Number, required: true },
  open: Number,
  high: Number,
  low: Number,
  close: Number,
  volume: Number
},
);

// to prevent duplicates
candleSchema.index(
  { symbol: 1,interval: 1, timestamp: 1 },
  { unique: true }
);

module.exports = mongoose.model("candle", candleSchema);
