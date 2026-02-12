const authService = require("./auth.service");
const { registerSchema, loginSchema, refreshSchema, logoutSchema } = require("./auth.validators");

function getCtx(req) {
  const raw = req.headers["x-device-id"];
  const deviceId = typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 128) : null;

  return {
    ip: req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip,
    ua: req.headers["user-agent"] || null,
    deviceId,
  };
}

async function register(req, res, next) {
  try {
    const input = registerSchema.parse(req.body);
    const user = await authService.register(input, getCtx(req));
    res.status(201).json({ ok: true, user });
  } catch (e) {
    next(e);
  }
}

async function login(req, res, next) {
  try {
    const input = loginSchema.parse(req.body);
    const tokens = await authService.login(input, getCtx(req));
    res.json({ ok: true, tokens });
  } catch (e) {
    next(e);
  }
}

async function me(req, res, next) {
  try {
    const user = await authService.getMe(req.auth.userId);
    res.json({ ok: true, user });
  } catch (e) {
    next(e);
  }
}

async function refresh(req, res, next) {
  try {
    const input = refreshSchema.parse(req.body);
    const tokens = await authService.refreshSession(input, getCtx(req));
    res.json({ ok: true, tokens });
  } catch (e) {
    next(e);
  }
}

async function logout(req, res, next) {
  try {
    const input = logoutSchema.parse(req.body);
    const out = await authService.logoutSession(input, getCtx(req));
    res.json({ ok: true, ...out });
  } catch (e) {
    next(e);
  }
}

module.exports = { register, login, me, refresh, logout };
