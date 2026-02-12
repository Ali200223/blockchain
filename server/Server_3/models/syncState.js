// core_files/models/syncState.js
const mongoose = require("mongoose");

const syncStateSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, unique: true, index: true, trim: true },

    // We store the smallest fillId we have backfilled down to (descending pagination uses id < cursorId)
    backfillCursorId: { type: Number, default: null },

    // Timestamp tracking
    lastRunAt: { type: Date, default: null },
    lastError: { type: String, default: null, trim: true },
  },
  { timestamps: false }
);

module.exports = mongoose.model("SyncState", syncStateSchema);
