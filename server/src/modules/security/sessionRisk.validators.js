const { z } = require("zod");

const uuidSchema = z.string().uuid();

const startSessionSchema = z
  .object({
    rotate: z.coerce.boolean().optional().default(false),
    ttlHours: z.coerce.number().int().min(1).max(168).optional(), // up to 7 days
  })
  .strict();

const scoreSessionSchema = z
  .object({
    sessionId: uuidSchema.optional(),
    intent: z.string().trim().min(1).max(64).optional(), // e.g. "login", "trade", "wallet_withdraw"
    persist: z.coerce.boolean().optional().default(true),
  })
  .strict();

const endSessionSchema = z
  .object({
    sessionId: uuidSchema.optional(),
    reason: z.string().trim().min(1).max(64).optional().default("user_logout"),
  })
  .strict();

module.exports = {
  startSessionSchema,
  scoreSessionSchema,
  endSessionSchema,
};
