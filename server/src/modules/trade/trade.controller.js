// server/src/modules/trade/trade.controller.js
const svcMod = require("./trade.service");
const tradeService = svcMod.tradeService || svcMod; // supports both export styles
const v = require("./trade.validators");
const { getSpotPrice } = require("../../services/binancePrice.service");

const executeSchema = v.executeSchema;
const executeInternalSchema = v.executeInternalSchema;

const buySchema = v.buySchema;
const sellSchema = v.sellSchema;

function assertFn(fn, name) {
  if (typeof fn !== "function") {
    const err = new Error(`${name} is not a function (check trade.service exports)`);
    err.status = 500;
    throw err;
  }
}

function assertSchema(schema, name) {
  if (!schema || typeof schema.parse !== "function") {
    const err = new Error(`${name} missing/invalid (check trade.validators exports)`);
    err.status = 500;
    throw err;
  }
}

function parseDecToInt(s, scale) {
  const str = String(s).trim();
  if (!/^\d+(\.\d+)?$/.test(str)) throw Object.assign(new Error("Invalid decimal"), { status: 400 });

  const [i, fRaw = ""] = str.split(".");
  const f = (fRaw + "0".repeat(scale)).slice(0, scale);
  return BigInt(i) * (10n ** BigInt(scale)) + BigInt(f || "0");
}

function assertSlippage({ side, execPriceStr, expectedPriceStr, maxSlippageBps }) {
  if (!expectedPriceStr) return;

  const bps = BigInt(maxSlippageBps ?? 50); // default 0.50%
  const exp = parseDecToInt(expectedPriceStr, 8);
  const exec = parseDecToInt(execPriceStr, 8);

  // bound = expected * (1 +/- bps/10000)
  if (side === "BUY") {
    const bound = (exp * (10000n + bps)) / 10000n;
    if (exec > bound) throw Object.assign(new Error("Slippage too high for BUY"), { status: 409, code: "SLIPPAGE" });
  } else {
    const bound = (exp * (10000n - bps)) / 10000n;
    if (exec < bound) throw Object.assign(new Error("Slippage too high for SELL"), { status: 409, code: "SLIPPAGE" });
  }
}

async function buy(req, res, next) {
  try {
    assertSchema(buySchema, "buySchema");
    assertFn(tradeService.buy, "tradeService.buy");

    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const input = buySchema.parse(req.body || {});

    // Authoritative execution price from Binance
    const executionPrice = await getSpotPrice(input.symbol);

    // Optional slippage guard (supports legacy clients passing `price`)
    assertSlippage({
      side: "BUY",
      execPriceStr: executionPrice,
      expectedPriceStr: input.expectedPrice ?? input.price,
      maxSlippageBps: input.maxSlippageBps,
    });

    const out = await tradeService.buy({
      userId,
      symbol: input.symbol,
      qty: input.qty,
      price: executionPrice,
      fee: input.fee ?? "0",
      referenceId: input.referenceId,
      requestId: req.ctx?.requestId || null,
    });

    return res.json({ ok: true, executionPrice, ...out, requestId: req.ctx?.requestId });
  } catch (e) {
    next(e);
  }
}

async function sell(req, res, next) {
  try {
    assertSchema(sellSchema, "sellSchema");
    assertFn(tradeService.sell, "tradeService.sell");

    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const input = sellSchema.parse(req.body || {});

    // Authoritative execution price from Binance
    const executionPrice = await getSpotPrice(input.symbol);

    // Optional slippage guard (supports legacy clients passing `price`)
    assertSlippage({
      side: "SELL",
      execPriceStr: executionPrice,
      expectedPriceStr: input.expectedPrice ?? input.price,
      maxSlippageBps: input.maxSlippageBps,
    });

    const out = await tradeService.sell({
      userId,
      symbol: input.symbol,
      qty: input.qty,
      price: executionPrice,
      fee: input.fee ?? "0",
      referenceId: input.referenceId,
      requestId: req.ctx?.requestId || null,
    });

    return res.json({ ok: true, executionPrice, ...out, requestId: req.ctx?.requestId });
  } catch (e) {
    next(e);
  }
}

async function execute(req, res, next) {
  try {
    assertSchema(executeSchema, "executeSchema");
    assertFn(tradeService.buy, "tradeService.buy");
    assertFn(tradeService.sell, "tradeService.sell");

    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const input = executeSchema.parse(req.body || {});

    // Authoritative execution price
    const executionPrice = await getSpotPrice(input.symbol);

    // Optional slippage guard
    assertSlippage({
      side: input.side,
      execPriceStr: executionPrice,
      expectedPriceStr: input.expectedPrice,
      maxSlippageBps: input.maxSlippageBps,
    });

    const fn = input.side === "BUY" ? tradeService.buy : tradeService.sell;

    const out = await fn({
      userId,
      symbol: input.symbol,
      qty: input.qty,
      price: executionPrice,
      fee: input.fee ?? "0",
      referenceId: input.referenceId,
      requestId: req.ctx?.requestId || null,
    });

    return res.json({ ok: true, executionPrice, ...out, requestId: req.ctx?.requestId });
  } catch (e) {
    next(e);
  }
}

async function executeInternal(req, res, next) {
  try {
    assertSchema(executeInternalSchema, "executeInternalSchema");
    assertFn(tradeService.buy, "tradeService.buy");
    assertFn(tradeService.sell, "tradeService.sell");

    const input = executeInternalSchema.parse(req.body || {});

    const executionPrice = await getSpotPrice(input.symbol);

    assertSlippage({
      side: input.side,
      execPriceStr: executionPrice,
      expectedPriceStr: input.expectedPrice,
      maxSlippageBps: input.maxSlippageBps,
    });

    const fn = input.side === "BUY" ? tradeService.buy : tradeService.sell;

    const out = await fn({
      userId: input.userId,
      symbol: input.symbol,
      qty: input.qty,
      price: executionPrice,
      fee: input.fee ?? "0",
      referenceId: input.referenceId,
      requestId: req.ctx?.requestId || null,
    });

    return res.json({ ok: true, executionPrice, ...out });
  } catch (e) {
    next(e);
  }
}

async function getFillByReference(req, res, next) {
  try {
    assertFn(tradeService.getFillByReference, "tradeService.getFillByReference");

    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const referenceId = String(req.params.referenceId || "").trim();
    if (!referenceId) return res.status(400).json({ ok: false, error: "Missing referenceId" });

    const fill = await tradeService.getFillByReference({ userId, referenceId });
    if (!fill) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, fill });
  } catch (e) {
    next(e);
  }
}

async function getFillById(req, res, next) {
  try {
    assertFn(tradeService.getFillById, "tradeService.getFillById");

    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Invalid id" });

    const fill = await tradeService.getFillById({ userId, id });
    if (!fill) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, fill });
  } catch (e) {
    next(e);
  }
}

async function listFills(req, res, next) {
  try {
    assertFn(tradeService.listFills, "tradeService.listFills");

    const userId = req.auth?.userId;
    if (!userId) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { limit, cursorId, symbol, side } = req.query || {};
    const out = await tradeService.listFills({ userId, limit, cursorId, symbol, side });

    return res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

// Internal versions (service-to-service) - protected by requireInternalKey middleware
async function getFillByReferenceInternal(req, res, next) {
  try {
    assertFn(tradeService.getFillByReferenceInternal, "tradeService.getFillByReferenceInternal");

    const userId = String(req.query.userId || req.body?.userId || "").trim();
    const referenceId = String(req.params.referenceId || "").trim();
    if (!userId || !referenceId) return res.status(400).json({ ok: false, error: "Missing userId or referenceId" });

    const fill = await tradeService.getFillByReferenceInternal({ userId, referenceId });
    if (!fill) return res.status(404).json({ ok: false, error: "Not found" });

    return res.json({ ok: true, fill });
  } catch (e) {
    next(e);
  }
}

async function listFillsInternal(req, res, next) {
  try {
    assertFn(tradeService.listFillsInternal, "tradeService.listFillsInternal");

    const userId = String(req.query.userId || req.body?.userId || "").trim();
    if (!userId) return res.status(400).json({ ok: false, error: "Missing userId" });

    const { limit, cursorId } = req.query || {};
    const out = await tradeService.listFillsInternal({ userId, limit, cursorId });

    return res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

module.exports = {
  buy,
  sell,
  execute,
  executeInternal,
  listFills,
  getFillByReference,
  getFillById,
  listFillsInternal,
  getFillByReferenceInternal,
};
