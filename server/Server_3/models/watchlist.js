const mongoose = require("mongoose");

const watchlistSchema = new mongoose.Schema(
  {
    userId: {type: Number,required: true},
    symbol: {type: String,required: true}
  },
  { timestamps: true }
);

watchlistSchema.index(
  { userId: 1, symbol: 1 },
  { unique: true }
);

module.exports = mongoose.model("Watchlist", watchlistSchema);
