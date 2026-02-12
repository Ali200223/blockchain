const { pool } = require("../../config/mysql");
const { logSecurityEvent } = require("./securityLog.service");
const { trackDeviceAndIp } = require("./securityTracking.service"); 

function decide(risk) {
  if (risk >= 70) return "BLOCK_SENSITIVE";
  if (risk >= 35) return "STEP_UP_REQUIRED";
  return "ALLOW";
}

async function getMyFeatures(userId, ctx) {
  
  const { newDevice, newIp } = await trackDeviceAndIp(userId, ctx);

  const [statsRows] = await pool.execute(
    `
    SELECT
      SUM(event_type = 'LOGIN_SUCCESS' AND created_at > NOW() - INTERVAL 5 MINUTE) AS login_success_5m,
      SUM(event_type = 'LOGIN_SUCCESS' AND created_at > NOW() - INTERVAL 1 HOUR) AS login_success_1h,
      SUM(event_type LIKE 'LOGIN_FAIL_%' AND created_at > NOW() - INTERVAL 15 MINUTE) AS login_fail_15m,
      COUNT(DISTINCT IF(created_at > NOW() - INTERVAL 24 HOUR, ip, NULL)) AS distinct_ip_24h,
      COUNT(DISTINCT IF(created_at > NOW() - INTERVAL 7 DAY, user_agent, NULL)) AS distinct_ua_7d
    FROM security_logs
    WHERE user_id = :userId
    `,
    { userId }
  );

  const stats = statsRows[0] || {};

  const [lastLoginRows] = await pool.execute(
    `
    SELECT ip, user_agent, created_at
    FROM security_logs
    WHERE user_id = :userId AND event_type = 'LOGIN_SUCCESS'
    ORDER BY created_at DESC
    LIMIT 1
    `,
    { userId }
  );

  const lastLogin = lastLoginRows[0] || null;

  
  const ipDrift = Boolean(
    newIp || (lastLogin?.ip && ctx?.ip && lastLogin.ip !== ctx.ip)
  );

  const deviceDrift = Boolean(
    newDevice || (lastLogin?.user_agent && ctx?.ua && lastLogin.user_agent !== ctx.ua)
  );

  const [driftRows] = await pool.execute(
    `
    SELECT
      (SELECT COUNT(*) FROM user_devices WHERE user_id = :userId AND last_seen > NOW() - INTERVAL 30 DAY) AS distinct_device_30d,
      (SELECT COUNT(*) FROM user_ip_history WHERE user_id = :userId AND last_seen > NOW() - INTERVAL 7 DAY) AS distinct_ip_7d
    `,
    { userId }
  );

  const drift = driftRows[0] || {};

  let risk = 0;
  if (Number(stats.login_fail_15m || 0) >= 5) risk += 40;
  if (Number(stats.distinct_ip_24h || 0) >= 4) risk += 25;
  if (Number(stats.distinct_ua_7d || 0) >= 3) risk += 15;
  if (Number(drift.distinct_ip_7d || 0) >= 4) risk += 10;
  if (Number(drift.distinct_device_30d || 0) >= 3) risk += 10;
  if (ipDrift) risk += 15;
  if (deviceDrift) risk += 10;

  risk = Math.max(0, Math.min(100, risk));

  const action = decide(risk);

  await logSecurityEvent({
    userId,
    eventType: "SECURITY_FEATURES_COMPUTED",
    ctx,
    metadata: {
      risk,
      action,
      ipDrift,
      deviceDrift,
      
      newIp,
      newDevice,
      stats,
      drift,
    },
  });

  return { stats, drift, ipDrift, deviceDrift, risk, action, lastLogin };
}

module.exports = { getMyFeatures };
