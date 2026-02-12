const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

// --- Load environment early ---
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

// If you have a separate migration user, use it ONLY for migPool
const MYSQL_HOST = process.env.MYSQL_HOST || "127.0.0.1";
const MYSQL_PORT = Number(process.env.MYSQL_PORT || 3306);
const MYSQL_DB = process.env.MYSQL_DATABASE;

const APP_USER = process.env.MYSQL_USER;
const APP_PASS = process.env.MYSQL_PASSWORD;

const MIG_USER = process.env.MYSQL_MIGRATE_USER || APP_USER;
const MIG_PASS = process.env.MYSQL_MIGRATE_PASSWORD || APP_PASS;

if (!MYSQL_DB) {
  console.error("❌ MYSQL_DATABASE is not set");
  process.exit(1);
}
if (!APP_USER) {
  console.error("❌ MYSQL_USER is not set");
  process.exit(1);
}

// Pool for running .sql migrations (MUST NOT parse :placeholders)
const migPool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: MIG_USER,
  password: MIG_PASS,
  database: MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0,
  namedPlaceholders: false,
});

// Pool for app-like queries (admin seeding uses :named placeholders)
const appPool = mysql.createPool({
  host: MYSQL_HOST,
  port: MYSQL_PORT,
  user: APP_USER,
  password: APP_PASS,
  database: MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 2,
  queueLimit: 0,
  namedPlaceholders: true,
});

async function ensureMigrationsTable() {
  await migPool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function hasRun(filename) {
  const [rows] = await migPool.execute(
    `SELECT 1 FROM schema_migrations WHERE filename = ? LIMIT 1`,
    [filename]
  );
  return rows.length > 0;
}

// NOTE: simple splitter; OK for your current DDL-style migrations.
// If you later add procedures/triggers with DELIMITER, replace this.
function splitSql(sql) {
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function runFile(filename, fullPath) {
  const sql = fs.readFileSync(fullPath, "utf8");
  const statements = splitSql(sql);

  const conn = await migPool.getConnection();
  try {
    await conn.beginTransaction();

    for (const stmt of statements) {
      // IMPORTANT: use query() and no params (namedPlaceholders is OFF here)
      await conn.query(stmt);
    }

    await conn.execute(
      `INSERT INTO schema_migrations (filename) VALUES (?)`,
      [filename]
    );

    await conn.commit();
    console.log(`✅ Applied ${filename}`);
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function seedAdminFromEnv() {
  const email = (process.env.ADMIN_SEED_EMAIL || "").trim();
  const password = process.env.ADMIN_SEED_PASSWORD || "";

  // Make phone optional: after clean DB, you still want admin bootstrapped.
  // If your schema enforces phone NOT NULL, this default prevents seed skipping.
  const phone = (process.env.ADMIN_SEED_PHONE || "1000000000").trim();

  if (!email || !password) {
    console.log("ℹ️  ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD not set; skipping admin bootstrap");
    return;
  }

  const conn = await appPool.getConnection();
  try {
    await conn.beginTransaction();

    const [rows] = await conn.execute(
      `SELECT id, role FROM users WHERE email = :email LIMIT 1`,
      { email }
    );

    let userId;

    if (rows.length) {
      userId = rows[0].id;

      if (rows[0].role !== "admin") {
        await conn.execute(`UPDATE users SET role='admin' WHERE id=:id`, { id: userId });
        console.log(`✅ Promoted existing user to admin: ${email}`);
      } else {
        console.log(`↩️  Admin already exists: ${email}`);
      }
    } else {
      userId = crypto.randomUUID();
      const password_hash = await bcrypt.hash(password, 12);

      await conn.execute(
        `INSERT INTO users (id, email, phone, password_hash, role, is_active)
         VALUES (:id, :email, :phone, :password_hash, 'admin', true)`,
        { id: userId, email, phone, password_hash }
      );

      console.log(`✅ Created admin user: ${email}`);
    }

    // Ensure KYC row exists (if your system expects it)
    await conn.execute(
      `INSERT IGNORE INTO kyc_applications (user_id) VALUES (:userId)`,
      { userId }
    );

    // Ensure wallet row exists
    try {
      await conn.execute(
        `INSERT IGNORE INTO wallets (user_id, balance, currency, status)
         VALUES (:userId, 0.00, :currency, 'LOCKED')`,
        { userId, currency: process.env.WALLET_CURRENCY || "USDT" }
      );
    } catch (e) {
      if (e && e.code === "ER_BAD_FIELD_ERROR") {
        await conn.execute(
          `INSERT IGNORE INTO wallets (user_id, balance) VALUES (:userId, 0.00)`,
          { userId }
        );
      } else {
        throw e;
      }
    }

    await conn.commit();
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

async function run() {
  // Show DB user (using migration creds)
  try {
    const [rows] = await migPool.query("SELECT CURRENT_USER() AS current_user, USER() AS db_user");
    console.log("[migrate] db_user =", rows[0]);
  } catch (e) {
    console.error("[migrate] db_user check failed:", e.message);
  }

  await ensureMigrationsTable();

  const dir = path.join(__dirname, "migrations");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  for (const file of files) {
    if (await hasRun(file)) {
      console.log(`↩️  Skipped ${file}`);
      continue;
    }
    await runFile(file, path.join(dir, file));
  }

  console.log("✅ Migrations complete");
  await seedAdminFromEnv();

  await migPool.end();
  await appPool.end();
}

run().then(
  () => process.exit(0),
  async (err) => {
    console.error("❌ Migration failed:", err.message);
    try { await migPool.end(); } catch {}
    try { await appPool.end(); } catch {}
    process.exit(1);
  }
);
