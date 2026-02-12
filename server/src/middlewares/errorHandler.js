const { logger } = require("../config/logger");
const { ZodError } = require("zod");

function isZodError(err) {
  return (
    !!err &&
    (err instanceof ZodError ||
      err.name === "ZodError" ||
      Array.isArray(err.issues) ||
      Array.isArray(err.errors))
  );
}

function toHttpStatus(err, fallback = 500) {
  const raw = err?.status ?? err?.statusCode;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 100 || n > 599) return fallback;
  return n;
}

function errorHandler(err, req, res, _next) {
  const isZod = isZodError(err);
  const zodIssues = isZod ? (err.issues || err.errors) : undefined;
  const status = isZod ? 400 : toHttpStatus(err, 500);

  const details =
    process.env.NODE_ENV === "production" ? undefined : (err?.details ?? undefined);

  const payload = {
    requestId: req.ctx?.requestId,
    status,
    path: req.originalUrl || req.path,
    method: req.method,
    msg: err?.message,
    details,
    zodIssues,
    stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
  };

  if (status >= 500) logger.error(payload, "request_error");
  else logger.warn(payload, "request_rejected");

  if (isZod) {
    return res.status(400).json({
      ok: false,
      error: "Validation error",
      requestId: req.ctx?.requestId,
      details: process.env.NODE_ENV === "production" ? undefined : zodIssues,
    });
  }

  return res.status(status).json({
    ok: false,
    requestId: req.ctx?.requestId,
    error: status >= 500 ? "Internal Server Error" : (err?.message || "Request failed"),
    details,
  });
}

module.exports = { errorHandler };
