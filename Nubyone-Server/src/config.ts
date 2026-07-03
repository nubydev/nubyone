import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";

export function getDataDir(): string {
  const dir = process.env.NUBYONE_DATA_DIR || path.resolve("./data");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function generateSecret(length = 64): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}

export interface Config {
  port: number;
  host: string;
  jwtSecret: string;
  adminUser: string;
  adminPass: string;
  dataDir: string;
  cookieSecure: boolean;
}

let _config: Config | null = null;

export function loadConfig(): Config {
  if (_config) return _config;

  const dataDir = getDataDir();
  const savePath = path.join(dataDir, "save.json");

  let savedSecrets: Record<string, string> = {};
  try {
    if (existsSync(savePath)) {
      savedSecrets = JSON.parse(readFileSync(savePath, "utf-8"));
    }
  } catch {}

  let jwtSecret = process.env.JWT_SECRET || savedSecrets.jwtSecret || "";
  if (!jwtSecret) {
    jwtSecret = generateSecret(64);
    savedSecrets.jwtSecret = jwtSecret;
    try {
      writeFileSync(savePath, JSON.stringify(savedSecrets, null, 2));
    } catch {}
    console.log("[config] Generated new JWT secret");
  }

  const secureCookieEnv = String(process.env.NUBYONE_AUTH_COOKIE_SECURE || "auto").toLowerCase();
  let cookieSecure: boolean;
  if (secureCookieEnv === "auto") {
    // Auto-detect: secure cookies when running under HTTPS (Replit deploy, VPS via NODE_ENV, etc.)
    cookieSecure = !!(
      process.env.REPL_DEPLOYMENT ||
      process.env.REPLIT_DEPLOYMENT ||
      process.env.NODE_ENV === "production"
    );
  } else {
    cookieSecure = secureCookieEnv === "true" || secureCookieEnv === "1";
  }

  _config = {
    port: Number(process.env.PORT) || 5000,
    host: process.env.HOST || "0.0.0.0",
    jwtSecret,
    adminUser: process.env.ADMIN_USER || "anon_",
    adminPass: process.env.ADMIN_PASS || "Neki999",
    dataDir,
    cookieSecure,
  };

  return _config;
}

export function getConfig(): Config {
  return _config ?? loadConfig();
}
