const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

dotenv.config();

const DB_NAME = process.env.DB_NAME || "arogyasetu_db";
const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || ""
};
const ROLES = new Set(["patient", "caretaker", "doctor", "nurse", "hospital", "admin", "volunteer"]);
const DB_FILE = path.join(__dirname, "..", "data", "db.json");
const SCHEMA_FILE = path.join(__dirname, "..", "database", "init.sql");

function assertDatabaseName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error("DB_NAME may contain only letters, numbers, and underscores.");
  }
}

function asExtra(record, knownFields) {
  const extra = {};
  for (const [key, value] of Object.entries(record)) {
    if (!knownFields.has(key)) extra[key] = value;
  }
  return JSON.stringify(extra);
}

function validateData(data) {
  for (const key of ["users", "medicines", "alerts", "vitals"]) {
    if (!Array.isArray(data[key])) throw new Error(`data/db.json must contain a ${key} array.`);
  }
  if (!data.sos || typeof data.sos !== "object" || Array.isArray(data.sos)) {
    throw new Error("data/db.json must contain an SOS object.");
  }
  for (const user of data.users) {
    if (!user.id || !ROLES.has(user.role) || !user.email || !user.password) {
      throw new Error("Every user must have an ID, valid role, email, and password.");
    }
  }
  for (const record of [...data.medicines, ...data.alerts, ...data.vitals]) {
    if (record.id !== undefined && (!Number.isSafeInteger(Number(record.id)) || Number(record.id) < 0)) {
      throw new Error("Record IDs must be non-negative safe integers.");
    }
  }
}

async function ensureSchema() {
  assertDatabaseName(DB_NAME);
  const connection = await mysql.createConnection({ ...DB_CONFIG, multipleStatements: true });
  try {
    const schema = fs.readFileSync(SCHEMA_FILE, "utf8").replace(/arogyasetu_db/g, DB_NAME);
    await connection.query(schema);
  } finally {
    await connection.end();
  }
}

async function importRecords(connection, data) {
  const counts = {
    users: { imported: 0, skipped: 0 },
    medicines: { imported: 0, skipped: 0 },
    alerts: { imported: 0, skipped: 0 },
    vitals: { imported: 0, skipped: 0 },
    sos: { imported: 0, skipped: 0 }
  };

  for (const user of data.users) {
    const password = String(user.password);
    const passwordHash = /^\$2[aby]\$\d\d\$/.test(password) ? password : await bcrypt.hash(password, 12);
    const [result] = await connection.execute(
      "INSERT IGNORE INTO users (id, role, name, email, password_hash, phone, language, meta, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        String(user.id),
        user.role,
        user.name,
        String(user.email).trim().toLowerCase(),
        passwordHash,
        user.phone || null,
        user.language || "en",
        JSON.stringify(user.meta === undefined ? {} : user.meta),
        asExtra(user, new Set(["id", "role", "name", "email", "password", "password_hash", "phone", "language", "meta"]))
      ]
    );
    counts.users[result.affectedRows ? "imported" : "skipped"] += 1;
  }

  for (const [index, medicine] of data.medicines.entries()) {
    const fields = [medicine.name, medicine.dose ?? null, medicine.time ?? null, medicine.status ?? "pending", index, asExtra(medicine, new Set(["id", "name", "dose", "time", "status"]))];
    const [result] = medicine.id === undefined
      ? await connection.execute(
        "INSERT IGNORE INTO medicines (name, dose, time, status, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?)",
        fields
      )
      : await connection.execute(
        "INSERT IGNORE INTO medicines (id, name, dose, time, status, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [Number(medicine.id), ...fields]
      );
    counts.medicines[result.affectedRows ? "imported" : "skipped"] += 1;
  }

  for (const [index, alert] of data.alerts.entries()) {
    const fields = [
      alert.type,
      alert.title ?? null,
      alert.detail ?? null,
      alert.time ?? null,
      Boolean(alert.acknowledged),
      index,
      asExtra(alert, new Set(["id", "type", "title", "detail", "time", "acknowledged"]))
    ];
    const [result] = alert.id === undefined
      ? await connection.execute(
        "INSERT IGNORE INTO alerts (type, title, detail, time, acknowledged, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        fields
      )
      : await connection.execute(
        "INSERT IGNORE INTO alerts (id, type, title, detail, time, acknowledged, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [Number(alert.id), ...fields]
      );
    counts.alerts[result.affectedRows ? "imported" : "skipped"] += 1;
  }

  for (const [index, vital] of data.vitals.entries()) {
    const fields = [
      vital.time ?? null,
      vital.bp ?? null,
      vital.sugar ?? null,
      vital.by ?? null,
      index,
      asExtra(vital, new Set(["id", "time", "bp", "sugar", "by"]))
    ];
    const [result] = vital.id === undefined
      ? await connection.execute(
        "INSERT IGNORE INTO vitals (time, bp, sugar, recorded_by, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?)",
        fields
      )
      : await connection.execute(
        "INSERT IGNORE INTO vitals (id, time, bp, sugar, recorded_by, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [Number(vital.id), ...fields]
      );
    counts.vitals[result.affectedRows ? "imported" : "skipped"] += 1;
  }

  const sos = data.sos;
  const [sosResult] = await connection.execute(
    "INSERT IGNORE INTO sos (id, active, timestamp, triggered_by, extra_json) VALUES (1, ?, ?, ?, ?)",
    [
      Boolean(sos.active),
      sos.timestamp ?? null,
      sos.triggeredBy ?? null,
      asExtra(sos, new Set(["active", "timestamp", "triggeredBy"]))
    ]
  );
  counts.sos[sosResult.affectedRows ? "imported" : "skipped"] = 1;
  return counts;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  validateData(data);
  await ensureSchema();

  const pool = mysql.createPool({ ...DB_CONFIG, database: DB_NAME, waitForConnections: true, connectionLimit: 5 });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const counts = await importRecords(connection, data);
    await connection.commit();
    console.log("JSON to MySQL migration complete (data/db.json was not modified).");
    for (const [table, count] of Object.entries(counts)) {
      console.log(`${table}: ${count.imported} imported, ${count.skipped} skipped`);
    }
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error("Migration failed; no JSON data was changed:", error);
  process.exitCode = 1;
});
