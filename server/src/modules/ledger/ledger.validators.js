const { z } = require("zod");

const commitBodySchema = z.object({
  maxItems: z.coerce.number().int().min(1).max(2000).optional(),
  // can also be provided via header: Idempotency-Key / X-Idempotency-Key
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
});

const verifyQuerySchema = z.object({
  maxBlocks: z.coerce.number().int().min(1).max(5000).optional(),
});

const listBlocksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const listActionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const unlockBodySchema = z
  .object({
    all: z.coerce.boolean().optional(),
    key: z.string().trim().min(1).max(200).optional(),
    staleOnly: z.coerce.boolean().optional(),
    // optional override for "stale" definition (ms)
    maxAgeMs: z.coerce.number().int().min(1000).max(1000 * 60 * 60 * 24).optional(),
  })
  .refine((x) => !(x.all && x.key), { message: "Provide either all or key, not both." });

const heightParamSchema = z.object({
  height: z.coerce.number().int().min(1),
});

const txIdParamSchema = z.object({
  txId: z.coerce.number().int().min(1),
});

const logIdParamSchema = z.object({
  logId: z.coerce.number().int().min(1),
});

const tradeIdParamSchema = z.object({
  tradeId: z.coerce.number().int().min(1),
});


module.exports = {
  commitBodySchema,
  verifyQuerySchema,
  listBlocksQuerySchema,
  listActionsQuerySchema,
  unlockBodySchema,
  heightParamSchema,
  txIdParamSchema,
  logIdParamSchema,
  tradeIdParamSchema,


};
