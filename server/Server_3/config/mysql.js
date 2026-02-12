const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "localhost",
  user: "root",
  password: "76692",
  database: "crypto_project"
});

module.exports = pool;
