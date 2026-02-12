const mongoose = require("mongoose");

const newsSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true
  },

  source: {
    type: String,
    required: true
  },

  url: {
    type: String,
    required: true,
    unique: true
  },

  published_at: {
    type: Date,
    required: true
  },

  content: {
    type: String,
    default: ""
  },

  /* 🔧 SAFE CATEGORY */
  category: {
    type: String,
    enum: ["asset", "regulatory", "exchange", "general"],
    default: "general"
  },

  /* 🔥 OVERALL SENTIMENT */
  sentiment: {
    type: String,
    enum: ["positive", "neutral", "negative"],
    default: "neutral"
  },

  /* 🔥 PER-ASSET SENTIMENT (NEW) */
  asset_sentiments: [
    {
      pair: { type: String, required: true },
      sentiment: {
        type: String,
        enum: ["positive", "neutral", "negative"],
        required: true
      },
      score: {
        type: Number,
        required: true
      }
    }
  ],

  created_at: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("News", newsSchema);
