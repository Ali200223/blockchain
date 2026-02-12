require("dotenv").config();
const mysql = require("mysql2/promise");

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
  });

  const [rows] = await conn.query("SELECT 1 AS ok");
  console.log(rows);

  await conn.end();
})().catch((e) => {
  console.error("DB TEST FAILED:", e.message);
  process.exit(1);
});
