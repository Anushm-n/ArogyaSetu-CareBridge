const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");
const crypto = require("crypto");
const dotenv = require("dotenv");
const bcrypt = require("bcryptjs");
const mysql = require("mysql2/promise");

dotenv.config();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const SESSION_COOKIE = "carebridge_session";
const SESSION_SECONDS = 12 * 60 * 60;
const ROLES = new Set(["patient", "caretaker", "doctor", "nurse", "hospital", "admin", "volunteer"]);
const SELF_REGISTER_ROLES = new Set(["patient", "caretaker", "volunteer"]);
const LANGUAGES = {
  en: { name: "English", speech: "en-IN" },
  kn: { name: "Kannada", speech: "kn-IN" },
  hi: { name: "Hindi", speech: "hi-IN" },
  ta: { name: "Tamil", speech: "ta-IN" },
  te: { name: "Telugu", speech: "te-IN" }
};
const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "arogyasetu_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
};
const pool = mysql.createPool(DB_CONFIG);

function sendJSON(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function jsonValue(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return typeof value === "string" ? JSON.parse(value) : value;
}

function publicUser(row) {
  const extra = jsonValue(row.extra_json, {}) || {};
  delete extra.password;
  delete extra.password_hash;
  return {
    ...extra,
    id: row.id,
    role: row.role,
    name: row.name,
    email: row.email,
    phone: row.phone,
    language: row.language,
    meta: jsonValue(row.meta, null)
  };
}

function publicRecord(row) {
  const extra = jsonValue(row.extra_json, {}) || {};
  const { extra_json: _json, ...fields } = row;
  if (fields.status_date instanceof Date) {
    fields.status_date = fields.status_date.toISOString().slice(0, 10);
  }
  return { ...extra, ...fields };
}

async function getUsers() {
  const [rows] = await pool.execute(
    "SELECT id, role, name, email, phone, language, meta, extra_json FROM users ORDER BY id"
  );
  return rows.map(publicUser);
}

async function getMedicines() {
  const [rows] = await pool.execute(
    "SELECT id, name, dose, notes, time, status, status_date, extra_json FROM medicines ORDER BY display_order, id"
  );
  return rows.map(publicRecord);
}

async function getAlerts() {
  const [rows] = await pool.execute(
    "SELECT id, type, title, detail, time, acknowledged, extra_json FROM alerts ORDER BY display_order, id"
  );
  return rows.map(row => {
    const alert = publicRecord(row);
    alert.acknowledged = Boolean(alert.acknowledged);
    return alert;
  });
}

async function getVitals() {
  const [rows] = await pool.execute(
    "SELECT time, bp, sugar, recorded_by AS `by`, extra_json FROM vitals ORDER BY display_order, id"
  );
  return rows.map(publicRecord);
}

async function getSos() {
  const [rows] = await pool.execute(
    "SELECT active, timestamp, triggered_by AS triggeredBy, extra_json FROM sos WHERE id = 1"
  );
  if (!rows.length) return { active: false, timestamp: null, triggeredBy: null };
  const sos = publicRecord(rows[0]);
  sos.active = Boolean(sos.active);
  return sos;
}

async function insertAlert(alert) {
  const [orderRows] = await pool.execute("SELECT COALESCE(MIN(display_order), 0) - 1 AS next_order FROM alerts");
  await pool.execute(
    "INSERT INTO alerts (type, title, detail, time, acknowledged, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      alert.type,
      alert.title,
      alert.detail,
      alert.time,
      Boolean(alert.acknowledged),
      orderRows[0].next_order,
      JSON.stringify({})
    ]
  );
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const separator = cookie.indexOf("=");
    if (separator < 0 || cookie.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(cookie.slice(separator + 1).trim());
    } catch (error) {
      return null;
    }
  }
  return null;
}

function sessionHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res, token, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
  );
}

async function authenticate(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenDigest = sessionHash(token);
  const [rows] = await pool.execute(
    "SELECT u.id, u.role, u.name, u.email, u.phone, u.language, u.meta, u.extra_json FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP() LIMIT 1",
    [tokenDigest]
  );
  if (!rows.length) {
    await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [tokenDigest]);
    return null;
  }
  return publicUser(rows[0]);
}

function canAccessAPI(user, method, pathname) {
  if (method === "GET" && pathname === "/api/state") return true;
  if (method === "POST" && pathname === "/api/ai/chat") return true;
  if (method === "POST" && pathname === "/api/medicines") {
    return ["patient", "doctor"].includes(user.role);
  }
  if (method === "PUT" && /^\/api\/medicines\/\d+$/.test(pathname)) {
    return ["patient", "nurse"].includes(user.role);
  }
  if (method === "POST" && pathname === "/api/alerts") {
    return ["patient", "doctor", "nurse"].includes(user.role);
  }
  if (method === "POST" && pathname === "/api/alerts/ack") {
    return ["caretaker", "nurse", "admin"].includes(user.role);
  }
  if (method === "POST" && pathname === "/api/sos") {
    return ["patient", "caretaker", "doctor", "nurse", "hospital", "admin"].includes(user.role);
  }
  if (method === "POST" && pathname === "/api/vitals") return user.role === "nurse";
  if (method === "POST" && pathname === "/api/reset") return user.role === "admin";
  return false;
}

async function createSession(user, res) {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.execute(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 12 HOUR))",
    [sessionHash(token), user.id]
  );
  setSessionCookie(res, token, SESSION_SECONDS);
}

function parseCookieExpiry() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

async function handleLogin(req, res) {
  const { role, email, password } = await parseBody(req);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!normalizedEmail || !password || (role && !ROLES.has(role))) {
    return sendJSON(res, 400, { success: false, message: "Role, email, and password are required." });
  }

  const [rows] = await pool.execute(
    "SELECT id, role, name, email, password_hash, phone, language, meta, extra_json FROM users WHERE email = ? LIMIT 1",
    [normalizedEmail]
  );
  const user = rows[0];
  if (!user || (role && user.role !== role) || !(await bcrypt.compare(String(password), user.password_hash))) {
    return sendJSON(res, 401, {
      success: false,
      message: "Invalid credentials or role mismatch. Check email, password, and selected entity role."
    });
  }

  await pool.execute("DELETE FROM sessions WHERE expires_at <= UTC_TIMESTAMP()");
  await createSession(user, res);
  return sendJSON(res, 200, { success: true, user: publicUser(user) });
}

async function handleRegister(req, res) {
  const { role, name, email, password, phone, language } = await parseBody(req);
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const cleanName = String(name || "").trim();
  if (!role || !ROLES.has(role) || !cleanName || !normalizedEmail || !password) {
    return sendJSON(res, 400, { success: false, message: "A valid role, name, email, and password are required." });
  }
  if (String(password).length < 8) {
    return sendJSON(res, 400, { success: false, message: "Password must be at least 8 characters." });
  }

  const requestingUser = await authenticate(req);
  const createdByAdmin = requestingUser && requestingUser.role === "admin";
  if (!SELF_REGISTER_ROLES.has(role) && !createdByAdmin) {
    return sendJSON(res, 403, {
      success: false,
      message: "Clinical and administrator accounts must be created by an authenticated administrator."
    });
  }

  const user = {
    id: `USR-${role.slice(0, 3).toUpperCase()}-${crypto.randomBytes(6).toString("hex").toUpperCase()}`,
    role,
    name: cleanName,
    email: normalizedEmail,
    phone: phone || "+91 98450-00000",
    language: Object.prototype.hasOwnProperty.call(LANGUAGES, language) ? language : "en",
    meta: { verified: true }
  };
  try {
    await pool.execute(
      "INSERT INTO users (id, role, name, email, password_hash, phone, language, meta, extra_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        user.id,
        user.role,
        user.name,
        user.email,
        await bcrypt.hash(String(password), 12),
        user.phone,
        user.language,
        JSON.stringify(user.meta),
        JSON.stringify({})
      ]
    );
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return sendJSON(res, 409, { success: false, message: "An account with this email already exists." });
    }
    throw error;
  }

  if (!createdByAdmin) {
    await createSession(user, res);
    return sendJSON(res, 201, { success: true, user });
  }
  return sendJSON(res, 201, {
    success: true,
    authenticated: false,
    user,
    message: "Account created. Sign in with the new account to continue."
  });
}

async function handleAIChat(req, res) {
  const { message, language } = await parseBody(req);
  const question = String(message || "").trim();
  const lang = String(language || "");
  if (!question || question.length > 2000 || !Object.prototype.hasOwnProperty.call(LANGUAGES, lang)) {
    return sendJSON(res, 400, { success: false, message: "Enter a question of up to 2,000 characters and select a supported language." });
  }
  if (!process.env.AI_API_URL || !process.env.AI_API_KEY || !process.env.AI_MODEL) {
    return sendJSON(res, 503, {
      success: false,
      message: "The AI provider is not configured on the server. Set AI_API_URL, AI_API_KEY, and AI_MODEL in .env."
    });
  }

  let endpoint;
  try {
    endpoint = new URL(process.env.AI_API_URL);
  } catch (error) {
    return sendJSON(res, 503, { success: false, message: "The configured AI endpoint URL is invalid." });
  }
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    return sendJSON(res, 503, { success: false, message: "The configured AI endpoint must use HTTP or HTTPS." });
  }

  let providerResponse;
  try {
    providerResponse = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.AI_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        messages: [
          {
            role: "system",
            content: `You are a basic health information assistant, not a medical professional. Respond in ${LANGUAGES[lang].name}; use simple, clear language. Do not diagnose, prescribe, change medication doses, or claim to contact emergency services. For severe or urgent symptoms, advise contacting local emergency services and a qualified clinician immediately. For other concerns, provide cautious general information and encourage professional care.`
          },
          { role: "user", content: question }
        ],
        temperature: 0.2,
        max_tokens: 700
      }),
      signal: AbortSignal.timeout(20000)
    });
  } catch (error) {
    const message = error.name === "TimeoutError"
      ? "The AI provider timed out. Please try again."
      : "Could not reach the configured AI provider.";
    return sendJSON(res, 502, { success: false, message });
  }
  if (!providerResponse.ok) {
    console.error("AI provider returned HTTP", providerResponse.status);
    return sendJSON(res, 502, { success: false, message: "The configured AI provider could not process the request." });
  }

  let result;
  try {
    result = await providerResponse.json();
  } catch (error) {
    return sendJSON(res, 502, { success: false, message: "The AI provider returned an invalid response." });
  }
  const content = result.choices && result.choices[0] && result.choices[0].message
    ? result.choices[0].message.content
    : null;
  const reply = Array.isArray(content)
    ? content.map(part => typeof part === "string" ? part : part.text || "").join("").trim()
    : String(content || "").trim();
  if (!reply) return sendJSON(res, 502, { success: false, message: "The AI provider returned an empty response." });
  return sendJSON(res, 200, { success: true, reply, language: lang });
}

async function getDashboardState(role) {
  const canSeeMedicines = ["patient", "caretaker", "doctor", "nurse", "hospital", "admin"].includes(role);
  const canSeeAlerts = ["patient", "caretaker", "doctor", "nurse", "hospital", "admin"].includes(role);
  const canSeeVitals = ["patient", "caretaker", "doctor", "nurse", "hospital", "admin"].includes(role);
  const [users, medicines, alerts, vitals, sos] = await Promise.all([
    role === "admin" ? getUsers() : [],
    canSeeMedicines ? getMedicines() : [],
    canSeeAlerts ? getAlerts() : [],
    canSeeVitals ? getVitals() : [],
    getSos()
  ]);
  return { success: true, users, medicines, alerts, vitals, sos };
}

async function handleProtectedAPI(req, res, pathname, user) {
  if (pathname === "/api/state" && req.method === "GET") {
    return sendJSON(res, 200, await getDashboardState(user.role));
  }

  if (pathname === "/api/ai/chat" && req.method === "POST") {
    return handleAIChat(req, res);
  }

  if (pathname === "/api/medicines" && req.method === "POST") {
    const body = await parseBody(req);
    const name = String(body.name || "").trim();
    const time = String(body.time || "");
    if (!name || !/^\d{2}:\d{2}$/.test(time)) {
      return sendJSON(res, 400, { success: false, message: "Medicine name and a valid scheduled time are required." });
    }
    const dose = String(body.dose || "Regular dose").trim();
    const notes = String(body.notes || "").trim();
    const [orders] = await pool.execute("SELECT COALESCE(MAX(display_order), -1) + 1 AS next_order FROM medicines");
    const [result] = await pool.execute(
      "INSERT INTO medicines (name, dose, notes, time, status, status_date, display_order, extra_json) VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)",
      [name, dose, notes || null, time, orders[0].next_order, JSON.stringify({})]
    );
    const medicine = {
      id: result.insertId,
      name,
      dose,
      notes,
      time,
      status: "pending",
      status_date: null
    };
    return sendJSON(res, 201, { success: true, medicine, medicines: await getMedicines() });
  }

  if (pathname.startsWith("/api/medicines/") && req.method === "PUT") {
    const id = Number(pathname.split("/").pop());
    const { status } = await parseBody(req);
    if (!Number.isSafeInteger(id) || id < 0 || !["pending", "due", "taken", "skipped"].includes(status)) {
      return sendJSON(res, 400, { success: false, message: "Invalid medicine ID or status." });
    }
    const [rows] = await pool.execute("SELECT id, name, dose, time, status FROM medicines WHERE id = ?", [id]);
    if (!rows.length) return sendJSON(res, 404, { success: false, message: "Medicine not found" });
    const medicine = rows[0];
    await pool.execute("UPDATE medicines SET status = ?, status_date = CURDATE() WHERE id = ?", [status, id]);
    if (status === "skipped" && medicine.status !== "skipped") {
      await insertAlert({
        type: "SKIPPED_DOSE",
        title: `Missed/Skipped Dose: ${medicine.name} (${medicine.time})`,
        detail: `Patient Ramesh Kumar skipped ${medicine.name} (${medicine.dose}). Caretaker Ananya & Nurse Kavita notified for immediate follow-up.`,
        time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        acknowledged: false
      });
    }
    return sendJSON(res, 200, { success: true, medicines: await getMedicines(), alerts: await getAlerts() });
  }

  if (pathname === "/api/alerts" && req.method === "POST") {
    const body = await parseBody(req);
    if (!body.title || !body.detail) {
      return sendJSON(res, 400, { success: false, message: "Alert title and detail are required." });
    }
    await insertAlert({
      type: body.type || "CRITICAL_SYMPTOM",
      title: String(body.title),
      detail: String(body.detail),
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      acknowledged: false
    });
    return sendJSON(res, 201, { success: true, alerts: await getAlerts() });
  }

  if (pathname === "/api/alerts/ack" && req.method === "POST") {
    await pool.execute("UPDATE alerts SET acknowledged = TRUE");
    return sendJSON(res, 200, { success: true, alerts: await getAlerts() });
  }

  if (pathname === "/api/sos" && req.method === "POST") {
    const { active, triggeredBy } = await parseBody(req);
    const sos = await getSos();
    sos.active = Boolean(active);
    if (active) {
      sos.timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      sos.triggeredBy = triggeredBy || user.name;
      await insertAlert({
        type: "SOS_PANIC",
        title: "🚨 EMERGENCY SOS PANIC BUTTON TRIGGERED",
        detail: "Live GPS (14.2847° N, 74.8920° E — Siddapur) & Emergency Health ID broadcasted to Hospital ER, Doctor, Nurse, Caretaker & Volunteers.",
        time: sos.timestamp,
        acknowledged: false
      });
    }
    await pool.execute(
      "INSERT INTO sos (id, active, timestamp, triggered_by, extra_json) VALUES (1, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE active = VALUES(active), timestamp = VALUES(timestamp), triggered_by = VALUES(triggered_by)",
      [sos.active, sos.timestamp, sos.triggeredBy, JSON.stringify({})]
    );
    return sendJSON(res, 200, { success: true, sos, alerts: await getAlerts() });
  }

  if (pathname === "/api/vitals" && req.method === "POST") {
    const { bp, sugar, by } = await parseBody(req);
    if (!bp || !sugar) return sendJSON(res, 400, { success: false, message: "Blood pressure and sugar values are required." });
    const time = "Just now (" + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ")";
    const [orders] = await pool.execute("SELECT COALESCE(MIN(display_order), 0) - 1 AS next_order FROM vitals");
    await pool.execute(
      "INSERT INTO vitals (time, bp, sugar, recorded_by, display_order, extra_json) VALUES (?, ?, ?, ?, ?, ?)",
      [time, String(bp), String(sugar), by || user.name, orders[0].next_order, JSON.stringify({})]
    );
    return sendJSON(res, 201, { success: true, vitals: await getVitals() });
  }

  if (pathname === "/api/reset" && req.method === "POST") {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute("DELETE FROM medicines");
      await connection.execute("DELETE FROM alerts");
      await connection.execute(
        "INSERT INTO medicines (id, name, dose, notes, time, status, status_date, display_order, extra_json) VALUES (?, ?, ?, NULL, ?, ?, CURDATE(), ?, ?), (?, ?, ?, NULL, ?, ?, CURDATE(), ?, ?), (?, ?, ?, NULL, ?, ?, CURDATE(), ?, ?)",
        [
          101, "Metformin 500mg", "After breakfast", "08:30", "taken", 0, JSON.stringify({}),
          102, "Telmisartan 40mg", "Morning BP tablet", "09:00", "due", 1, JSON.stringify({}),
          103, "Atorvastatin 10mg", "After dinner", "21:00", "pending", 2, JSON.stringify({})
        ]
      );
      await connection.execute(
        "INSERT INTO sos (id, active, timestamp, triggered_by, extra_json) VALUES (1, FALSE, NULL, NULL, ?) ON DUPLICATE KEY UPDATE active = FALSE, timestamp = NULL, triggered_by = NULL",
        [JSON.stringify({})]
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    return sendJSON(res, 200, { success: true });
  }

  return sendJSON(res, 404, { success: false, message: "API endpoint not found" });
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function sendStaticFile(res, pathname) {
  const relativePath = pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      ...(ext === ".html" ? { "Cache-Control": "no-store" } : {})
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const pathname = url.parse(req.url, true).pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Cache-Control": "no-store" });
    return res.end();
  }

  try {
    if (pathname.startsWith("/api/")) {
      if (pathname === "/api/auth/login" && req.method === "POST") {
        return await handleLogin(req, res);
      }
      if (pathname === "/api/auth/register" && req.method === "POST") {
        return await handleRegister(req, res);
      }
      if (pathname === "/api/auth/logout" && req.method === "POST") {
        const token = readCookie(req, SESSION_COOKIE);
        if (token && /^[a-f0-9]{64}$/.test(token)) {
          await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [sessionHash(token)]);
        }
        res.setHeader("Set-Cookie", parseCookieExpiry());
        return sendJSON(res, 200, { success: true });
      }
      if (pathname === "/api/auth/session" && req.method === "GET") {
        const user = await authenticate(req);
        if (!user) {
          res.setHeader("Set-Cookie", parseCookieExpiry());
          return sendJSON(res, 401, { success: false, message: "Authentication required." });
        }
        return sendJSON(res, 200, { success: true, user });
      }

      const user = await authenticate(req);
      if (!user) return sendJSON(res, 401, { success: false, message: "Authentication required." });
      if (!canAccessAPI(user, req.method, pathname)) {
        return sendJSON(res, 403, { success: false, message: "Your role is not permitted to perform this action." });
      }
      return await handleProtectedAPI(req, res, pathname, user);
    }

    if (pathname === "/index.html") {
      const user = await authenticate(req);
      if (!user) {
        res.writeHead(302, { Location: "/login.html", "Cache-Control": "no-store" });
        return res.end();
      }
    }
    sendStaticFile(res, pathname === "/" ? "/login.html" : pathname);
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    if (error instanceof SyntaxError) {
      return sendJSON(res, 400, { success: false, message: "Invalid JSON payload." });
    }
    console.error("Request failed:", error);
    const unavailable = [
      "ECONNREFUSED",
      "ECONNRESET",
      "PROTOCOL_CONNECTION_LOST",
      "ETIMEDOUT",
      "ER_ACCESS_DENIED_ERROR",
      "ER_BAD_DB_ERROR",
      "ER_NO_SUCH_TABLE"
    ].includes(error.code);
    return sendJSON(res, unavailable ? 503 : 500, {
      success: false,
      message: unavailable ? "Database unavailable. Check the MySQL service and configuration." : "Request failed."
    });
  }
});

async function startServer() {
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.ping();
    for (const table of ["users", "medicines", "alerts", "vitals", "sos", "sessions"]) {
      await connection.query(`SELECT 1 FROM ${table} LIMIT 0`);
    }
    const [columns] = await connection.execute(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'medicines' AND COLUMN_NAME IN ('notes', 'status_date')"
    );
    const present = new Set(columns.map(column => column.COLUMN_NAME));
    if (!present.has("notes") || !present.has("status_date")) {
      throw new Error("Run npm run migrate:runtime to add required medicine reminder columns.");
    }
    connection.release();
    server.listen(PORT, () => {
      console.log(`ArogyaSetu (CareBridge) Server running at http://localhost:${PORT}/login.html`);
    });
  } catch (error) {
    if (connection) connection.release();
    console.error("Unable to initialize MySQL. Check .env and run npm run migrate:runtime.", error);
    await pool.end();
    process.exitCode = 1;
  }
}

startServer();
