const { z } = require("zod");


const symbolSchema = z.string().trim().min(2).max(20).regex(/^[A-Z0-9_\-]+$/);
const intervalSchema = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);

const baseSchema = z
  .object({
    symbols: z.array(symbolSchema).min(1).max(50),
    interval: intervalSchema.default("1h"),

    
    horizon: z.coerce.number().int().min(1).max(240).default(24),
    asOf: z.union([z.string().trim().min(1).max(40), z.coerce.number().int()]).optional(),

    includePropagation: z.coerce.boolean().optional().default(true),

    debugFeatures: z.record(z.record(z.number())).optional(),
    debugEdges: z.array(z.record(z.any())).optional(),
  })
  .passthrough();

const pricePredictionSchema = z.preprocess((val) => {
  if (!val || typeof val !== "object") return val;

  const o = { ...val };

  if (o.horizon == null && o.horizonSteps != null) o.horizon = o.horizonSteps;
  if (o.asOf == null && o.asOfTime != null) o.asOf = o.asOfTime;

  return o;
}, baseSchema);


const listPredictionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  beforeId: z
    .string()
    .trim()
    .regex(/^[a-fA-F0-9]{24}$/)
    .optional(),
});

module.exports = { pricePredictionSchema,listPredictionsQuerySchema  };
