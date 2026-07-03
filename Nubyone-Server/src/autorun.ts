import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import path from "path";
import { getDataDir } from "./config";

export interface AutorunScript {
  id: string;
  name: string;
  content: string;
  type: string;
  trigger: "on_connect" | "on_first_connect";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const firstConnectSeen = new Map<string, Set<string>>();
let _firstConnectLoaded = false;

function getFirstConnectFile(): string {
  return path.join(getDataDir(), "first-connect-seen.json");
}

function loadFirstConnectSeen(): void {
  if (_firstConnectLoaded) return;
  _firstConnectLoaded = true;
  try {
    const f = getFirstConnectFile();
    if (!existsSync(f)) return;
    const raw = JSON.parse(readFileSync(f, "utf8"));
    if (raw && typeof raw === "object") {
      for (const [scriptId, clientIds] of Object.entries(raw)) {
        if (Array.isArray(clientIds)) {
          firstConnectSeen.set(scriptId, new Set(clientIds as string[]));
        }
      }
    }
  } catch { /* ignore corrupted file */ }
}

function saveFirstConnectSeen(): void {
  try {
    const f = getFirstConnectFile();
    mkdirSync(path.dirname(f), { recursive: true });
    const out: Record<string, string[]> = {};
    for (const [scriptId, set] of firstConnectSeen) {
      out[scriptId] = [...set];
    }
    writeFileSync(f, JSON.stringify(out, null, 2));
  } catch (e) { console.error("[autorun] failed to persist first-connect state:", e); }
}

function getAutorunFile(): string {
  return path.join(getDataDir(), "autorun-scripts.json");
}

export function loadAutorunScripts(): AutorunScript[] {
  try {
    const f = getAutorunFile();
    if (!existsSync(f)) return [];
    const parsed = JSON.parse(readFileSync(f, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveAutorunScripts(scripts: AutorunScript[]): void {
  try {
    const f = getAutorunFile();
    mkdirSync(path.dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(scripts, null, 2));
  } catch (e) { console.error("[autorun] save error:", e); }
}

export function hasSeenFirstConnect(scriptId: string, clientId: string): boolean {
  loadFirstConnectSeen();
  return firstConnectSeen.get(scriptId)?.has(clientId) ?? false;
}

export function markFirstConnect(scriptId: string, clientId: string): void {
  loadFirstConnectSeen();
  let set = firstConnectSeen.get(scriptId);
  if (!set) { set = new Set(); firstConnectSeen.set(scriptId, set); }
  set.add(clientId);
  saveFirstConnectSeen();
}
