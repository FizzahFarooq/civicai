// MySQL database layer (mysql2 connection pool).
// Exposes a tiny helper API so the rest of the code stays simple:
//   await db.all(sql, params)    -> array of rows
//   await db.get(sql, params)    -> first row or undefined
//   await db.run(sql, params)    -> { insertId, affectedRows }
//   await db.count(sql, params)  -> number (query must return a column named n)
//   await db.tx(async (t) => {}) -> transaction; t has the same all/get/run/count helpers
const mysql = require('mysql2/promise');
const { DEPARTMENTS } = require('./config');

let pool = null;
const deptByCode = {}; // filled by init()
const deptById = {};   // filled by init()

function executor(conn) {
  const all = async (sql, params = []) => (await conn.query(sql, params))[0];
  const get = async (sql, params = []) => (await all(sql, params))[0];
  const run = async (sql, params = []) => {
    const [r] = await conn.query(sql, params);
    return { insertId: r.insertId, affectedRows: r.affectedRows };
  };
  const count = async (sql, params = []) => Number((await get(sql, params)).n);
  return { all, get, run, count };
}

// `db` always talks to the pool (pool is created in init()).
const db = executor({ query: (...a) => pool.query(...a) });

db.tx = async (fn) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const out = await fn(executor(conn));
    await conn.commit();
    return out;
  } catch (err) {
    try { await conn.rollback(); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    conn.release();
  }
};

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS departments (
  id   INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(30) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS issues (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  category            VARCHAR(40) NOT NULL,
  status              VARCHAR(20) NOT NULL DEFAULT 'submitted',
  severity            INT NOT NULL DEFAULT 0,
  severity_level      VARCHAR(20) NOT NULL DEFAULT 'low',
  severity_reason     TEXT,
  hazard              INT NOT NULL DEFAULT 3,
  lat                 DOUBLE NOT NULL,
  lng                 DOUBLE NOT NULL,
  context             TEXT,
  department_id       INT NULL,
  report_count        INT NOT NULL DEFAULT 1,
  first_reported_at   DATETIME(3) NOT NULL,
  last_reported_at    DATETIME(3) NOT NULL,
  resolved_at         DATETIME(3) NULL,
  verification_status VARCHAR(20) NOT NULL DEFAULT 'none',
  verification_note   TEXT,
  cover_photo         VARCHAR(100),
  after_photo         VARCHAR(100),
  ai_summary          TEXT,
  assignee            VARCHAR(80),
  INDEX idx_issues_status (status),
  INDEX idx_issues_geo (lat, lng),
  INDEX idx_issues_cat_status (category, status),
  CONSTRAINT fk_issues_dept FOREIGN KEY (department_id) REFERENCES departments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS reports (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  tracking_id   VARCHAR(20) NOT NULL UNIQUE,
  issue_id      INT NOT NULL,
  photo         VARCHAR(100),
  photo_hash    VARCHAR(16),
  description   TEXT,
  lat           DOUBLE NOT NULL,
  lng           DOUBLE NOT NULL,
  reporter_name VARCHAR(80),
  contact       VARCHAR(80),
  ai_json       TEXT,
  merge_note    VARCHAR(255),
  created_at    DATETIME(3) NOT NULL,
  INDEX idx_reports_issue (issue_id),
  CONSTRAINT fk_reports_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS events (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  issue_id   INT NOT NULL,
  \`type\`     VARCHAR(40) NOT NULL,
  note       TEXT,
  actor      VARCHAR(100),
  created_at DATETIME(3) NOT NULL,
  INDEX idx_events_issue (issue_id),
  CONSTRAINT fk_events_issue FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

`CREATE TABLE IF NOT EXISTS landmarks (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  name     VARCHAR(100) NOT NULL,
  \`type\`   ENUM('main_road','school','hospital','market') NOT NULL,
  lat      DOUBLE NOT NULL,
  lng      DOUBLE NOT NULL,
  radius_m INT NOT NULL DEFAULT 200
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

function friendly(err, cfg) {
  const where = `${cfg.host}:${cfg.port}`;
  if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
    return new Error(`Cannot reach MySQL at ${where}. Is the MySQL server running? (${err.code})`);
  }
  if (err.code === 'ER_ACCESS_DENIED_ERROR') {
    return new Error(`MySQL refused the login for user "${cfg.user}". Check DB_USER and DB_PASSWORD in your .env file.`);
  }
  if (err.code === 'ER_BAD_DB_ERROR' || err.code === 'ER_DBACCESS_DENIED_ERROR') {
    return new Error(`Database "${cfg.database}" does not exist or user "${cfg.user}" has no access to it. See "Set up MySQL" in the README.`);
  }
  return err;
}

// Call once at startup (before using db). Creates the database/tables if needed.
async function init() {
  const cfg = {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'civicai'
  };
  if (!/^[A-Za-z0-9_]+$/.test(cfg.database)) throw new Error('DB_NAME may only contain letters, numbers and underscores.');

  // Try to create the database if it is missing (needs permission; silently skipped if not allowed).
  try {
    const boot = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });
    await boot.query(`CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await boot.end();
  } catch (err) {
    if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ER_ACCESS_DENIED_ERROR'].includes(err.code)) throw friendly(err, cfg);
  }

  pool = mysql.createPool({
    ...cfg, waitForConnections: true, connectionLimit: 10, charset: 'utf8mb4',
    timezone: 'Z' // store and read all dates as UTC
  });
  try { await pool.query('SELECT 1'); } catch (err) { throw friendly(err, cfg); }

  for (const sql of SCHEMA) await pool.query(sql);

  for (const d of DEPARTMENTS) await pool.query('INSERT IGNORE INTO departments (code, name) VALUES (?, ?)', [d.code, d.name]);
  const [rows] = await pool.query('SELECT * FROM departments');
  for (const row of rows) { deptByCode[row.code] = row; deptById[row.id] = row; }
  return cfg;
}

async function close() { if (pool) { await pool.end(); pool = null; } }

// `exec` lets callers write the event inside a transaction (pass the `t` object).
async function addEvent(issueId, type, note, actor = 'system', exec = db) {
  await exec.run('INSERT INTO events (issue_id, `type`, note, actor, created_at) VALUES (?,?,?,?,?)',
    [issueId, type, note || null, actor, new Date()]);
}

module.exports = { db, init, close, deptByCode, deptById, addEvent };
