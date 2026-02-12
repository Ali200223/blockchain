const mongoose = require("mongoose");

const marketSymbolSchema = new mongoose.Schema({
  symbol: {
    type: String,
    required: true,
    unique: true
  },

  baseAsset: String,
  quoteAsset: String,

  enabled: {
    type: Boolean,
    default: false
  }
});

module.exports = mongoose.model("MarketSymbol", marketSymbolSchema);
