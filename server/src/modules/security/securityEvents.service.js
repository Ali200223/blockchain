const { pool } = require("../../config/mysql");

function parseJsonSafe(v) {
  if (v == null) return {};
  if (typeof v === "object") return v;
  if (typeof v !== "string") return {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
}

function clampLimit(n) {
  const x = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(x)) return 50;
  return Math.max(1, Math.min(200, x));
}

async function getMyEvents(userId, limit) {
  const lim = clampLimit(limit);

  const [rows] = await pool.execute(
    `
    SELECT id, event_type, ip, user_agent, metadata, created_at
    FROM security_logs
    WHERE user_id = :userId
    ORDER BY id DESC
    LIMIT ${lim}
    `,
    { userId }
  );

  const items = (rows || []).map((r) => ({
    id: r.id,
    eventType: r.event_type,
    ip: r.ip,
    userAgent: r.user_agent,
    metadata: parseJsonSafe(r.metadata),
    createdAt: r.created_at,
  }));

  return { limit: lim, items };
}

module.exports = { getMyEvents };
