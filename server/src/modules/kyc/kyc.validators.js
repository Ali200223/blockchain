const { z } = require("zod");

const docTypeEnum = z.enum(["PASSPORT"]);


const submitKycSchema = z.object({
  fullName: z
    .string()
    .trim()
    .min(3)
    .max(120)
    .regex(/^[\p{L}\p{M} .'-]+$/u),

  dob: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),

  country: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase()),

  docType: docTypeEnum,

  docNumber: z
    .string()
    .trim()
    .min(4)
    .max(40)
    .transform((v) => v.toUpperCase().replace(/\s+/g, "")),
});

const reviewKycSchema = z.object({
  userId: z.uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
  notes: z.string().trim().max(2000).optional().nullable(),
});

module.exports = { submitKycSchema, reviewKycSchema };
