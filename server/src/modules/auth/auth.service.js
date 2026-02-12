const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { pool } = require("../../config/mysql");
const { env } = require("../../config/env");
const { logSecurityEvent } = require("../security/securityLog.service");
const { trackDeviceAndIp, isNewDevice, isNewIp } = require("../security/securityTracking.service");

function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, env.JWT_ACCESS_SECRET, {
    expiresIn: Number(env.JWT_ACCESS_TTL_SECONDS),
  });
}

function signRefreshToken(user) {
  return jwt.sign({ sub: user.id, type: "refresh" }, env.JWT_REFRESH_SECRET, {
    expiresIn: Number(env.JWT_REFRESH_TTL_SECONDS),
  });
}

function normalizeCtx(ctx) {
  return {
    ip: ctx?.ip || null,
    ua: ctx?.ua || null,
    deviceId: ctx?.deviceId || null,
  };
}

function deriveDeviceId(ctx) {
  if (ctx.deviceId) return { deviceId: ctx.deviceId, source: "header" };

  const basis = `${ctx.ua || ""}|${ctx.ip || ""}`.trim();
  if (!basis) return { deviceId: null, source: "none" };

  const hash = crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
  return { deviceId: `fp_${hash}`, source: "fingerprint" };
}

async function logEvent({ userId = null, eventType, ctx, metadata = {} }) {
  const meta = { ...(metadata || {}) };
  if (ctx?.deviceId && meta.deviceId == null) meta.deviceId = ctx.deviceId;

  await logSecurityEvent({
    userId,
    eventType,
    ctx,
    metadata: meta,
  });
}

async function register({ email, password, phone }, ctxRaw) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [exists] = await conn.execute(
      `SELECT id
       FROM users
       WHERE email = :email OR phone = :phone
       LIMIT 1`,
      { email, phone }
    );

    if (exists.length) {
      await logEvent({
        userId: null,
        eventType: "REGISTER_FAIL_EXISTS",
        ctx,
        metadata: { email },
      });
      throw Object.assign(new Error("Account already exists"), { status: 409 });
    }

    const id = crypto.randomUUID();
    const password_hash = await bcrypt.hash(password, 12);

    await conn.execute(
      `INSERT INTO users (id, email, phone, password_hash)
       VALUES (:id, :email, :phone, :password_hash)`,
      { id, email, phone, password_hash }
    );

    await conn.execute(
      `INSERT INTO kyc_applications (user_id) VALUES (:userId)`,
      { userId: id }
    );

    // ✅ NEW: Ensure every user has exactly one wallet at registration (LOCKED until KYC APPROVED)
    // Requires: wallets.user_id UNIQUE
    await conn.execute(
      `INSERT IGNORE INTO wallets (user_id, balance, currency, status)
       VALUES (:userId, 0.00, :currency, 'LOCKED')`,

       { userId: id, currency: env.WALLET_CURRENCY }

    );

    await conn.commit();

    await trackDeviceAndIp(id, ctx);

    await logEvent({
      userId: id,
      eventType: "REGISTER_SUCCESS",
      ctx,
    });

    return { id, email, phone };
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function login({ email, password }, ctxRaw) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  const [rows] = await pool.execute(
    `SELECT id, email, role, password_hash, is_active
     FROM users
     WHERE email = :email
     LIMIT 1`,
    { email }
  );

  if (!rows.length) {
    await logEvent({
      userId: null,
      eventType: "LOGIN_FAIL_NOUSER",
      ctx,
      metadata: { email },
    });
    throw Object.assign(new Error("Invalid credentials"), { status: 401 });
  }

  const user = rows[0];

  if (!user.is_active) {
    await logEvent({
      userId: user.id,
      eventType: "LOGIN_FAIL_INACTIVE",
      ctx,
    });
    throw Object.assign(new Error("Account disabled"), { status: 403 });
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    await logEvent({
      userId: user.id,
      eventType: "LOGIN_FAIL_BADPASS",
      ctx,
    });
    throw Object.assign(new Error("Invalid credentials"), { status: 401 });
  }

  const deviceNew = await isNewDevice(user.id, ctx.deviceId || null);
  const ipNew = await isNewIp(user.id, ctx.ip || null);

  await trackDeviceAndIp(user.id, ctx);

  const access = signAccessToken(user);
  const refresh = signRefreshToken(user);
  const refreshHash = await bcrypt.hash(refresh, 10);

  await pool.execute(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL :ttl SECOND))`,
    { userId: user.id, tokenHash: refreshHash, ttl: Number(env.JWT_REFRESH_TTL_SECONDS) }
  );

  await logEvent({
    userId: user.id,
    eventType: "LOGIN_SUCCESS",
    ctx,
    metadata: { deviceNew, ipNew },
  });

  return { access, refresh };
}

async function getMe(userId) {
  const [rows] = await pool.execute(
    `SELECT id, email, phone, role, is_active, email_verified, phone_verified, created_at
     FROM users
     WHERE id = :id
     LIMIT 1`,
    { id: userId }
  );

  if (!rows.length) throw Object.assign(new Error("User not found"), { status: 404 });
  return rows[0];
}

async function refreshSession({ refresh }, ctxRaw) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  let payload;
  try {
    payload = jwt.verify(refresh, env.JWT_REFRESH_SECRET);
  } catch {
    await logEvent({ userId: null, eventType: "REFRESH_FAIL_INVALID_JWT", ctx });
    throw Object.assign(new Error("Invalid refresh token"), { status: 401 });
  }

  if (payload.type !== "refresh") {
    await logEvent({ userId: null, eventType: "REFRESH_FAIL_WRONG_TYPE", ctx });
    throw Object.assign(new Error("Invalid refresh token"), { status: 401 });
  }

  const userId = payload.sub;

  const [tokens] = await pool.execute(
    `SELECT id, token_hash
     FROM refresh_tokens
     WHERE user_id = :userId AND revoked = false AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 20`,
    { userId }
  );

  let matched = null;
  for (const row of tokens) {
    if (await bcrypt.compare(refresh, row.token_hash)) {
      matched = row;
      break;
    }
  }

  if (!matched) {
    await logEvent({ userId, eventType: "REFRESH_FAIL_NOT_FOUND", ctx });
    throw Object.assign(new Error("Invalid refresh token"), { status: 401 });
  }

  const [users] = await pool.execute(
    `SELECT id, role, is_active FROM users WHERE id = :id LIMIT 1`,
    { id: userId }
  );

  if (!users.length || !users[0].is_active) {
    await logEvent({ userId, eventType: "REFRESH_FAIL_INACTIVE", ctx });
    throw Object.assign(new Error("Account disabled"), { status: 403 });
  }

  const user = users[0];

  const newAccess = signAccessToken(user);
  const newRefresh = signRefreshToken(user);
  const newRefreshHash = await bcrypt.hash(newRefresh, 10);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    await conn.execute(
      `UPDATE refresh_tokens SET revoked = true WHERE user_id = :userId AND revoked = false`,
      { userId }
    );

    await conn.execute(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
       VALUES (:userId, :tokenHash, DATE_ADD(NOW(), INTERVAL :ttl SECOND))`,
      { userId: user.id, tokenHash: newRefreshHash, ttl: Number(env.JWT_REFRESH_TTL_SECONDS) }
    );

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }

  await trackDeviceAndIp(user.id, ctx);

  await logEvent({ userId: user.id, eventType: "REFRESH_SUCCESS", ctx });

  return { access: newAccess, refresh: newRefresh };
}

async function logoutSession({ refresh }, ctxRaw) {
  const ctx0 = normalizeCtx(ctxRaw);
  const d = deriveDeviceId(ctx0);
  const ctx = { ...ctx0, deviceId: d.deviceId, deviceIdSource: d.source };

  let payload;
  try {
    payload = jwt.verify(refresh, env.JWT_REFRESH_SECRET);
  } catch {
    await logEvent({ userId: null, eventType: "LOGOUT_FAIL_INVALID_JWT", ctx });
    throw Object.assign(new Error("Invalid refresh token"), { status: 401 });
  }

  const userId = payload.sub;

  const [tokens] = await pool.execute(
    `SELECT id, token_hash
     FROM refresh_tokens
     WHERE user_id = :userId AND revoked = false
     ORDER BY created_at DESC
     LIMIT 20`,
    { userId }
  );

  let matchedId = null;
  for (const row of tokens) {
    if (await bcrypt.compare(refresh, row.token_hash)) {
      matchedId = row.id;
      break;
    }
  }

  if (!matchedId) {
    await logEvent({ userId, eventType: "LOGOUT_FAIL_NOT_FOUND", ctx });
    throw Object.assign(new Error("Invalid refresh token"), { status: 401 });
  }

  await pool.execute(
    `UPDATE refresh_tokens SET revoked = true WHERE user_id = :userId AND revoked = false`,
    { userId }
  );

  await trackDeviceAndIp(userId, ctx);

  await logEvent({ userId, eventType: "LOGOUT_SUCCESS", ctx });

  return { ok: true };
}

module.exports = {
  register,
  login,
  getMe,
  refreshSession,
  logoutSession,
};
