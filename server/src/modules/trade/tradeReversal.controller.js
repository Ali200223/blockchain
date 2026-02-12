// server/src/modules/trade/tradeReversal.controller.js
const { z } = require("zod");
const { reverseTradeFill } = require("./tradeReversal.service");
const ledgerService = require("../ledger/ledger.service");


const bodySchema = z.object({
  referenceId: z.string().trim().min(8).max(64), // idempotency key
  reason: z.string().trim().min(1).max(255).optional(),
});

async function reverseTradeFillController(req, res, next) {
  try {
    const tradeFillId = Number(req.params.id);
    if (!Number.isFinite(tradeFillId) || tradeFillId <= 0) {
      return res.status(400).json({ ok: false, error: "Invalid fill id" });
    }

    const body = bodySchema.parse(req.body || {});

    const result = await reverseTradeFill({
      tradeFillId,
      referenceId: body.referenceId,
      reason: body.reason || "trade_reversal",
      actor: req.auth, // { userId, role, ... }
      requestId: req.ctx?.requestId || null,
    });
    let ledgerCommit = null;
try {
  ledgerCommit = await ledgerService.commitNextBlock({
    sealedByUserId: req.auth.userId,
    maxItems: 50,
    idempotencyKey: `auto:${req.ctx?.requestId || body.referenceId || Date.now()}`,
    meta: {
      requestId: req.ctx?.requestId,
      adminUserId: req.auth?.userId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
      deviceId: req.headers["x-device-id"],
    },
  });
} catch (e) {
  // swallow mining errors; action should still succeed
  ledgerCommit = { committed: false, reason: e.message, status: e.status || 500 };
}


    return res.json({ ok: true, ...result,ledgerCommit });
  } catch (err) {
    next(err);
  }
}

module.exports = { reverseTradeFillController };
