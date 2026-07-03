import { existsSync, readFileSync } from "fs";
import path from "path";
import { SignJWT, jwtVerify } from "jose";
import { getConfig, getDataDir } from "./config";

export interface TokenPayload {
  userId: number;
  username: string;
  role: string;
}

function getSecret(): Uint8Array {
  return new TextEncoder().encode(getConfig().jwtSecret);
}

function getSessionTtlSecs(): number {
  try {
    const f = path.join(getDataDir(), "app-settings.json");
    if (existsSync(f)) {
      const s = JSON.parse(readFileSync(f, "utf-8"));
      const h = Number(s?.security?.sessionTtlHours);
      if (Number.isFinite(h) && h > 0) return Math.max(3600, h * 3600);
    }
  } catch {}
  return 7 * 86400;
}

export async function signToken(payload: TokenPayload): Promise<string> {
  const ttlSecs = getSessionTtlSecs();
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSecs)
    .sign(getSecret());
}

export async function verifyToken(token: string): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as any as TokenPayload;
  } catch {
    return null;
  }
}

export async function getAuthFromRequest(req: Request): Promise<TokenPayload | null> {
  const cookie = req.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)zc_token=([^;]+)/);
  if (!match) return null;
  try {
    return await verifyToken(decodeURIComponent(match[1]));
  } catch {
    return null;
  }
}

export function buildCookie(token: string, maxAgeSec: number | null = null): string {
  const cfg = getConfig();
  const ttlSecs = maxAgeSec ?? getSessionTtlSecs();
  const parts = [
    `zc_token=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${ttlSecs}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(): string {
  const cfg = getConfig();
  const parts = ["zc_token=", "Path=/", "Max-Age=0", "HttpOnly", "SameSite=Lax"];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}
