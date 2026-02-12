const mongoose = require("mongoose");

const BacktestSchema = new mongoose.Schema({
  user_id: {
    type: String,
    required: true
  },
  symbol:{type: String, required: true},
  strategy: {
    type: String,
    enum: ["ma_crossover"],
    required: true
  },

  parameters: {
    short_window: {
      type: Number,
      required: true
    },
    long_window: {
      type: Number,
      required: true
    },
    initial_capital: {
      type: Number,
      default: 10000
    }
  },

  // Historical period used
  date_range: {
    start: {
      type: Date,
      required: true
    },
    end: {
      type: Date,
      required: true
    }
  },

  // Computed results
  metrics: {
    total_return_pct: Number,
    max_drawdown_pct: Number,
    trades_count: Number,
    win_rate_pct: Number
  },

  // Portfolio value over time
  equity_curve: [
    {
      timestamp: Date,
      equity: Number
    }
  ],

  // Trade execution history
  trades: [
    {
      timestamp: Date,
      side: {
        type: String,
        enum: ["BUY", "SELL"]
      },
      price: Number,
      quantity: Number
    }
  ],

  created_at: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model("Backtest", BacktestSchema);
