const dotenv = require("dotenv");
const mysql = require("mysql2/promise");

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "arogyasetu_db",
  waitForConnections: true,
  connectionLimit: 2
});

async function main() {
  let connection;
  try {
    connection = await pool.getConnection();
    const [columns] = await connection.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME IN ('notes', 'status_date')"
    );
    const existing = new Set(columns.map(column => column.COLUMN_NAME));

    if (!existing.has("notes")) {
      await connection.query("ALTER TABLE medicines ADD COLUMN notes TEXT NULL");
      console.log("Added medicines.notes.");
    }
    if (!existing.has("status_date")) {
      await connection.query("ALTER TABLE medicines ADD COLUMN status_date DATE NULL");
      console.log("Added medicines.status_date.");
    }

    await connection.query(
      "CREATE TABLE IF NOT EXISTS sessions (token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, user_id VARCHAR(64) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL, PRIMARY KEY (token_hash), KEY idx_sessions_user_id (user_id), KEY idx_sessions_expires_at (expires_at), CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE) ENGINE=InnoDB"
    );
    console.log("Session storage is ready. Existing user and health records were not modified.");
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error("Runtime migration failed; no existing records were deleted:", error.message);
  process.exitCode = 1;
});
