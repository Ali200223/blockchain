const { pool } = require("../../config/mysql");

function _normStr(v, maxLen) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  return maxLen ? s.slice(0, maxLen) : s;
}

async function trackDeviceAndIp(userId, ctx) {
  if (!userId || !ctx) return { newDevice: false, newIp: false };

  // normalize to match schema constraints
  const ip = _normStr(ctx.ip, 45);
  const ua = _normStr(ctx.ua, 2000);       // UA can be large; keep a reasonable cap
  const deviceId = _normStr(ctx.deviceId, 128);

  // IMPORTANT: compute "new" flags BEFORE upserts
  const newDevice = deviceId ? await isNewDevice(userId, deviceId) : false;
  const newIp = ip ? await isNewIp(userId, ip) : false;

  if (deviceId) {
    await pool.execute(
      `
      INSERT INTO user_devices (user_id, device_id, user_agent, last_ip)
      VALUES (:userId, :deviceId, :ua, :ip)
      ON DUPLICATE KEY UPDATE
        last_seen = NOW(),
        user_agent = VALUES(user_agent),
        last_ip = VALUES(last_ip)
      `,
      { userId, deviceId, ua, ip }
    );
  }

  if (ip) {
    await pool.execute(
      `
      INSERT INTO user_ip_history (user_id, ip)
      VALUES (:userId, :ip)
      ON DUPLICATE KEY UPDATE
        last_seen = NOW()
      `,
      { userId, ip }
    );
  }

  return { newDevice, newIp };
}

async function isNewDevice(userId, deviceId) {
  if (!userId || !deviceId) return false;

  const [rows] = await pool.execute(
    `SELECT 1 FROM user_devices WHERE user_id = :userId AND device_id = :deviceId LIMIT 1`,
    { userId, deviceId }
  );

  return rows.length === 0;
}

async function isNewIp(userId, ip) {
  if (!userId || !ip) return false;

  const [rows] = await pool.execute(
    `SELECT 1 FROM user_ip_history WHERE user_id = :userId AND ip = :ip LIMIT 1`,
    { userId, ip }
  );

  return rows.length === 0;
}

module.exports = { trackDeviceAndIp, isNewDevice, isNewIp };
