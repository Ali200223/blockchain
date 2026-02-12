const { z } = require("zod");

// Admin adjustment (kept)
const adminAdjustSchema = z
  .object({
    userId: z.string().uuid(),
    type: z.enum(["DEPOSIT", "WITHDRAW", "ADJUST"]),
    // Accepts "100" or 100, rejects NaN and +/-Infinity
    amount: z.coerce.number().finite(),
    description: z.string().trim().min(1).max(255),
    referenceId: z.string().uuid(),
  })
  .superRefine((data, ctx) => {
    const t = String(data.type).toUpperCase();
    const amt = Number(data.amount);

    if (!Number.isFinite(amt)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amount must be finite" });
      return;
    }

    if (t === "DEPOSIT" || t === "WITHDRAW") {
      if (amt <= 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amount must be > 0" });
    } else if (t === "ADJUST") {
      if (amt === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "amount must be non-zero" });
    }
  });

const listTxQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// User deposit / withdraw (idempotency: referenceId optional; requestId preferred via x-request-id)
const depositSchema = z.object({
  amount: z.coerce.number().finite().gt(0),
  source: z.string().trim().max(80).optional(),
  referenceId: z.string().uuid().optional(),
});

const withdrawSchema = z.object({
  amount: z.coerce.number().finite().gt(0),
  referenceId: z.string().uuid().optional(),
});

// Bank details (withdrawal account)
// We accept either IBAN/BIC (EU) or IFSC (India), but do not require either.
const bankSchema = z.object({
  bankName: z.string().trim().min(2).max(100),
  accountNumber: z.string().trim().min(3).max(50),
  iban: z.string().trim().min(8).max(34).optional(),
  bic: z.string().trim().min(6).max(11).optional(),
  ifscCode: z.string().trim().min(5).max(20).optional(),
});

module.exports = {
  adminAdjustSchema,
  listTxQuerySchema,
  depositSchema,
  withdrawSchema,
  bankSchema,
};
