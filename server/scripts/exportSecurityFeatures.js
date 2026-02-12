/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");

const { pool } = require("../src/config/mysql");

// Feature names must align with ML service anomaly endpoint expectations
const FEATURES = [
  "login_fail_15m",
  "login_success_5m",
  "login_success_1h",
  "distinct_ip_24h",
  "distinct_ip_7d",
  "distinct_ua_7d",
  "distinct_device_30d",
  "ipDrift",
  "uaDrift",
];

function argValue(name, fallback = null) {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return fallback;
  const v = process.argv[idx + 1];
  if (!v || v.startsWith("--")) return fallback;
  return v;
}

function argNumber(name, fallback) {
  const raw = argValue(name, String(fallback));
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function argList(name, fallbackCsv) {
  const raw = argValue(name, fallbackCsv);
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function ensureDirForFile(outPath) {
  const dir = path.dirname(outPath);
  fs.mkdirSync(dir, { recursive: true });
}

function iso(dt) {
  if (!dt) return null;
  const d = dt instanceof Date ? dt : new Date(dt);
  return d.toISOString();
}

function subMs(d, ms) {
  return new Date(d.getTime() - ms);
}

function daysToMs(n) {
  return n * 24 * 60 * 60 * 1000;
}

async function main() {
  const out = argValue("--out", null);
  if (!out) {
    console.error("Missing --out <path>");
    process.exit(2);
  }

  const days = argNumber("--days", 60);
  const limit = argNumber("--limit", 10000);
  const maxAnchors = argNumber("--maxAnchors", 2000);
  const minGapSeconds = argNumber("--minGapSeconds", 30);

  const anchorTypes = argList(
    "--anchorTypes",
    "LOGIN_SUCCESS,LOGIN_FAILED,LOGIN_FAIL,LOGIN_FAILURE,SESSION_STARTED,SESSION_RISK_SCORED"
  );

  ensureDirForFile(out);
  const ws = fs.createWriteStream(out, { flags: "w", encoding: "utf8" });

  console.log("[export] out:", out);
  console.log("[export] days:", days, "limit:", limit, "maxAnchors:", maxAnchors, "minGapSeconds:", minGapSeconds);
  console.log("[export] anchorTypes:", anchorTypes.join(","));

  // IMPORTANT:
  // Use positional placeholders "?" (mysql2 default).
  // Also avoid "NOW() - INTERVAL ? DAY" to prevent parameterization issues; just use DATE_SUB with a literal cutoff passed as a datetime.
  const cutoff = new Date(Date.now() - daysToMs(days));

  const anchorsSql = `
    SELECT
      id,
      user_id AS userId,
      event_type AS eventType,
      ip,
      user_agent AS ua,
      JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.deviceId')) AS deviceId,
      created_at AS createdAt
    FROM security_logs
    WHERE user_id IS NOT NULL
      AND event_type IN (${anchorTypes.map(() => "?").join(",")})
      AND created_at >= ?
    ORDER BY created_at DESC
    LIMIT ${Number(limit) | 0}
  `;

  const [anchors] = await pool.execute(anchorsSql, [...anchorTypes, cutoff]);

  const perUserLastTs = new Map();
  let written = 0;
  let scanned = 0;

  // Compute windows in JS for full compatibility
  // and avoid MySQL INTERVAL parameterization.
  const featuresSql = `
    SELECT
      (SELECT COUNT(*)
         FROM security_logs
        WHERE user_id = ?
          AND event_type = 'LOGIN_SUCCESS'
          AND created_at >= ?
          AND created_at <  ?
      ) AS login_success_5m,

      (SELECT COUNT(*)
         FROM security_logs
        WHERE user_id = ?
          AND event_type = 'LOGIN_SUCCESS'
          AND created_at >= ?
          AND created_at <  ?
      ) AS login_success_1h,

      (SELECT COUNT(*)
         FROM security_logs
        WHERE user_id = ?
          AND event_type IN ('LOGIN_FAILED','LOGIN_FAIL','LOGIN_FAILURE')
          AND created_at >= ?
          AND created_at <  ?
      ) AS login_fail_15m,

      (SELECT COUNT(DISTINCT ip)
         FROM security_logs
        WHERE user_id = ?
          AND ip IS NOT NULL
          AND created_at >= ?
          AND created_at <  ?
      ) AS distinct_ip_24h,

      (SELECT COUNT(DISTINCT ip)
         FROM user_ip_history
        WHERE user_id = ?
          AND last_seen >= ?
      ) AS distinct_ip_7d,

      (SELECT COUNT(DISTINCT user_agent)
         FROM security_logs
        WHERE user_id = ?
          AND user_agent IS NOT NULL
          AND created_at >= ?
          AND created_at <  ?
      ) AS distinct_ua_7d,

      (SELECT COUNT(DISTINCT device_id)
         FROM user_devices
        WHERE user_id = ?
          AND last_seen >= ?
      ) AS distinct_device_30d,

      CASE
        WHEN ? IS NULL OR ? = '' THEN 0
        WHEN EXISTS (
          SELECT 1
            FROM security_logs
           WHERE user_id = ?
             AND ip = ?
             AND created_at >= ?
             AND created_at <  ?
           LIMIT 1
        ) THEN 0
        ELSE 1
      END AS ipDrift,

      CASE
        WHEN ? IS NULL OR ? = '' THEN 0
        WHEN EXISTS (
          SELECT 1
            FROM security_logs
           WHERE user_id = ?
             AND user_agent = ?
             AND created_at >= ?
             AND created_at <  ?
           LIMIT 1
        ) THEN 0
        ELSE 1
      END AS uaDrift
  `;

  for (const a of anchors) {
    scanned += 1;
    if (written >= maxAnchors) break;

    const userId = a.userId;
    const t = a.createdAt instanceof Date ? a.createdAt : new Date(a.createdAt);

    // de-dup: keep at most one sample per user per minGapSeconds
    const last = perUserLastTs.get(userId);
    if (last && (last - t) / 1000 < minGapSeconds) continue;
    perUserLastTs.set(userId, t);

    const ip = a.ip || null;
    const ua = a.ua || null;

    const t5m = subMs(t, 5 * 60 * 1000);
    const t15m = subMs(t, 15 * 60 * 1000);
    const t1h = subMs(t, 60 * 60 * 1000);
    const t24h = subMs(t, 24 * 60 * 60 * 1000);
    const t7d = subMs(t, 7 * 24 * 60 * 60 * 1000);
    const t30d = subMs(t, 30 * 24 * 60 * 60 * 1000);

    // Keep placeholder order EXACTLY aligned with featuresSql
    const params = [
      // login_success_5m
      userId, t5m, t,
      // login_success_1h
      userId, t1h, t,
      // login_fail_15m
      userId, t15m, t,
      // distinct_ip_24h
      userId, t24h, t,
      // distinct_ip_7d (user_ip_history)
      userId, t7d,
      // distinct_ua_7d
      userId, t7d, t,
      // distinct_device_30d
      userId, t30d,
      // ipDrift
      ip, ip, userId, ip, t7d, t,
      // uaDrift
      ua, ua, userId, ua, t7d, t,
    ];

    const [rows] = await pool.execute(featuresSql, params);
    const f = rows?.[0] || {};

    const features = {};
    for (const k of FEATURES) features[k] = Number(f[k] ?? 0);

    const rec = {
      ts: iso(t),
      userId,
      eventType: a.eventType,
      ip,
      ua,
      deviceId: a.deviceId || null,
      ...features,
    };

    ws.write(JSON.stringify(rec) + "\n");
    written += 1;

    if (written % 100 === 0) console.log(`[export] wrote ${written} samples...`);
  }

  ws.end();

  console.log("[export] anchors scanned:", scanned);
  console.log("[export] samples written:", written);
  console.log("[export] done.");
}

main()
  .catch((e) => {
    console.error("[export] failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    try { await pool.end(); } catch {}
  });
