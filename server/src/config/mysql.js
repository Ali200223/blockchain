const mysql = require("mysql2/promise");
const { env } = require("./env");

const pool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,

  namedPlaceholders: true,

  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  connectTimeout: 10_000,

  // Optional:
  // timezone: "Z",
});

module.exports = { pool };
