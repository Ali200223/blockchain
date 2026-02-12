const pino = require("pino");

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined,

  // Prevent sensitive data leaks in logs (industrial baseline)
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['set-cookie']",
      "req.body.password",
      "req.body.confirmPassword",
      "req.body.refreshToken",
      "req.body.accessToken",
      "res.headers['set-cookie']",
      "*.password",
      "*.token",
      "*.access",
      "*.refresh",
    ],
    censor: "[REDACTED]",
    remove: false,
  },

  transport:
    process.env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

module.exports = { logger };
