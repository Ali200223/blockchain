const { pool } = require("../../config/mysql");

const MAX_EVENT_TYPE_LEN = 50;
const MAX_METADATA_BYTES = 8192;

function toJsonSafe(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return JSON.stringify({ nonSerializable: true });
  }
}

function clampMetadata(jsonStr) {
  const bytes = Buffer.byteLength(jsonStr, "utf8");
  if (bytes <= MAX_METADATA_BYTES) return jsonStr;
  return JSON.stringify({ truncated: true, maxBytes: MAX_METADATA_BYTES });
}

async function logSecurityEvent({
  userId = null,
  eventType,
  ctx = null,
  ip = null,
  userAgent = null,
  metadata = {},
}) {
  if (!eventType || typeof eventType !== "string") {
    const err = new Error("eventType is required");
    err.status = 500;
    throw err;
  }

  if (eventType.length > MAX_EVENT_TYPE_LEN) {
    const err = new Error("eventType too long");
    err.status = 500;
    throw err;
  }

  const meta = { ...(metadata || {}) };

  // only inject if caller didn't already provide it
  if (ctx?.deviceId && meta.deviceId == null) meta.deviceId = ctx.deviceId;

  const finalIp = ctx?.ip ?? ip ?? null;
  const finalUa = ctx?.ua ?? userAgent ?? null;

  const json = clampMetadata(toJsonSafe(meta));

  await pool.execute(
    `
    INSERT INTO security_logs (user_id, event_type, ip, user_agent, metadata)
    VALUES (:userId, :eventType, :ip, :userAgent, :metadata)
    `,
    {
      userId,
      eventType,
      ip: finalIp,
      userAgent: finalUa,
      metadata: json,
    }
  );
}

module.exports = { logSecurityEvent };
