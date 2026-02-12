const { z } = require("zod");

const registerSchema = z.object({
  email: z.email(),
  password: z.string().min(12).max(72),
  phone: z.string().min(6).max(30),
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(72),
});

const refreshSchema = z.object({
  refresh: z.string().min(20),
});

const logoutSchema = z.object({
  refresh: z.string().min(20),
});

module.exports = { registerSchema, loginSchema, refreshSchema, logoutSchema };
