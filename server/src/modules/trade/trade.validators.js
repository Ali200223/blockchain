// server/src/modules/trade/trade.validators.js
const { z } = require("zod");

const symbolSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Z0-9._-]+$/, "Invalid symbol format")
  .transform((s) => s.toUpperCase());

// accept either string or number, but always convert to a decimal string
function decimalStr(maxDp, fieldName) {
  return z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim())
    .refine((s) => /^\d+(\.\d+)?$/.test(s), `${fieldName} must be a decimal`)
    .refine((s) => (s.split(".")[1] || "").length <= maxDp, `${fieldName} too many decimals (max ${maxDp})`);
}

const qtyStr = decimalStr(10, "qty");
const priceStr = decimalStr(8, "price");
const feeStr = decimalStr(2, "fee").optional();
const expectedPriceStr = decimalStr(8, "expectedPrice").optional();

const referenceIdSchema = z.string().uuid();

const buySchema = z.object({
  symbol: symbolSchema,
  qty: qtyStr,
  fee: feeStr,
  referenceId: referenceIdSchema,

  // Market execution uses Binance price. For backward compatibility we still
  // accept `price` as an expected price hint.
  price: priceStr.optional(),
  expectedPrice: expectedPriceStr.optional(),
  maxSlippageBps: z.coerce.number().int().min(0).max(5000).optional(),
});

const sellSchema = z.object({
  symbol: symbolSchema,
  qty: qtyStr,
  fee: feeStr,
  referenceId: referenceIdSchema,

  // Market execution uses Binance price. For backward compatibility we still
  // accept `price` as an expected price hint.
  price: priceStr.optional(),
  expectedPrice: expectedPriceStr.optional(),
  maxSlippageBps: z.coerce.number().int().min(0).max(5000).optional(),
});


// New: market execution (Person A fetches Binance price)
const executeSchema = z.object({
  symbol: symbolSchema,
  side: z.enum(["BUY", "SELL"]),
  qty: qtyStr,
  fee: feeStr,
  referenceId: referenceIdSchema,

  // Optional slippage guard (recommended)
  expectedPrice: expectedPriceStr,
  maxSlippageBps: z.coerce.number().int().min(0).max(5000).optional(),
});

// New: internal executor (Person C job) executes “on behalf of userId”
const executeInternalSchema = executeSchema.extend({
  userId: z.string().uuid(),
});

module.exports = { buySchema, sellSchema, executeSchema, executeInternalSchema };
