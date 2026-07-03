import { decode as decodeMsgpack, encode as encodeMsgpack } from "@msgpack/msgpack";
import { notifyAgentDisconnect } from "./notifier";

export interface AgentInfo {
  id: string;
  hwid: string;
  host: string;
  os: string;
  arch: string;
  version: string;
  username: string;
  ip: string;
  country: string;
  buildTag: string;
  buildId: string;
  publicKey: string;
  inMemory: boolean;
  connectedAt: number;
}

type SendFn = (data: Uint8Array | ArrayBuffer) => void;

interface AgentConn {
  info: AgentInfo;
  send: SendFn;
  ping: () => void;
}

interface ViewerConn {
  clientId: string;
  send: SendFn;
  ping: () => void;
}

// In-memory connected agents: clientId → connection.
const agents = new Map<string, AgentConn>();

// Grace-period timers: agents that disconnected but haven't been evicted yet.
// During the grace window the agent still appears online (stays in `agents`).
const pendingOfflineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const OFFLINE_GRACE_MS = 40_000; // 40 s – covers worst-case 30 s reconnect delay

// In-memory connected console viewers: clientId → set of console viewer connections.
const consoleViewers = new Map<string, Set<ViewerConn>>();

// ----------------------------------------------------------------
// Agent lifecycle
// ----------------------------------------------------------------

/**
 * Register (or re-register) a connected agent.
 * Returns `true` if the agent was already in a grace-period reconnect window
 * (i.e. this is a silent reconnect — no "connected" notification should fire),
 * or `false` if this is a genuinely new connection.
 */
export function registerAgent(id: string, info: AgentInfo, send: SendFn, ping: () => void = () => {}): boolean {
  const wasInGrace = pendingOfflineTimers.has(id);
  if (wasInGrace) {
    // Reconnected within grace period – cancel eviction, no online broadcast needed
    clearTimeout(pendingOfflineTimers.get(id)!);
    pendingOfflineTimers.delete(id);
    console.log(`[agent-store] agent reconnected within grace period: ${id} (${info.host})`);
  }

  agents.set(id, { info, send, ping });
  console.log(`[agent-store] agent connected: ${id} (${info.host})`);
  return wasInGrace;
}

/**
 * Schedule an agent as offline after a grace period.
 * If the agent reconnects within the window it is kept online transparently.
 * @param onOffline - called when the grace period expires (e.g. to update the DB)
 */
export function unregisterAgent(id: string, onOffline?: () => void) {
  if (pendingOfflineTimers.has(id)) {
    // Already in grace period – refresh the timer but don't double-log
    clearTimeout(pendingOfflineTimers.get(id)!);
  }
  console.log(`[agent-store] agent disconnected: ${id} (grace ${OFFLINE_GRACE_MS}ms)`);

  const timer = setTimeout(() => {
    pendingOfflineTimers.delete(id);
    const info = agents.get(id)?.info;
    agents.delete(id);
    console.log(`[agent-store] agent offline (grace expired): ${id}`);
    if (info) {
      notifyAgentDisconnect({ host: info.host }).catch(() => {});
    }
    onOffline?.();
  }, OFFLINE_GRACE_MS);

  pendingOfflineTimers.set(id, timer);
}

export function getAgent(id: string): AgentConn | undefined {
  return agents.get(id);
}

export function listAgents(): AgentInfo[] {
  return Array.from(agents.values()).map((a) => a.info);
}

export function isAgentConnected(id: string): boolean {
  return agents.has(id);
}

export function getAllAgents(): { id: string; info: AgentInfo; send: SendFn }[] {
  return Array.from(agents.entries()).map(([id, a]) => ({ id, info: a.info, send: a.send }));
}

// ----------------------------------------------------------------
// Console viewer lifecycle
// ----------------------------------------------------------------

export function registerConsoleViewer(clientId: string, send: SendFn, ping: () => void): ViewerConn {
  const viewer: ViewerConn = { clientId, send, ping };
  if (!consoleViewers.has(clientId)) {
    consoleViewers.set(clientId, new Set());
  }
  consoleViewers.get(clientId)!.add(viewer);
  console.log(`[agent-store] console viewer connected for client: ${clientId}`);
  return viewer;
}

export function unregisterConsoleViewer(clientId: string, viewer: ViewerConn) {
  consoleViewers.get(clientId)?.delete(viewer);
  console.log(`[agent-store] console viewer disconnected for client: ${clientId}`);
}

export function relayConsoleOutputToViewer(clientId: string, data: Uint8Array) {
  const vset = consoleViewers.get(clientId);
  if (!vset || vset.size === 0) return;
  for (const viewer of vset) {
    try {
      viewer.send(data);
    } catch {}
  }
}

export function hasConsoleViewers(clientId: string): boolean {
  const vset = consoleViewers.get(clientId);
  return !!(vset && vset.size > 0);
}

// ----------------------------------------------------------------
// Helpers for decoding agent msgpack messages
// ----------------------------------------------------------------

export function decodeMsgpackSafe(data: Uint8Array): Record<string, unknown> | null {
  try {
    const msg = decodeMsgpack(data);
    if (msg && typeof msg === "object" && !Array.isArray(msg)) {
      return msg as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function pingAllConsoleViewers() {
  for (const vset of consoleViewers.values()) {
    for (const viewer of vset) {
      try { viewer.ping(); } catch {}
    }
  }
}

export function pingAllAgents() {
  for (const agent of agents.values()) {
    try { agent.ping(); } catch {}
  }
}

// ----------------------------------------------------------------
// Remote desktop viewer lifecycle (one viewer per client at a time)
// ----------------------------------------------------------------

const remoteViewers = new Map<string, ViewerConn>();

export function registerRemoteViewer(clientId: string, send: SendFn, ping: () => void, closePrev?: () => void): ViewerConn {
  const existing = remoteViewers.get(clientId);
  if (existing) {
    console.log(`[agent-store] evicting previous remote viewer for client: ${clientId}`);
    try { if (closePrev) closePrev(); } catch {}
  }
  const viewer: ViewerConn = { clientId, send, ping };
  remoteViewers.set(clientId, viewer);
  console.log(`[agent-store] remote viewer connected for client: ${clientId}`);
  return viewer;
}

export function unregisterRemoteViewer(clientId: string) {
  remoteViewers.delete(clientId);
  console.log(`[agent-store] remote viewer disconnected for client: ${clientId}`);
}

export function relayRemoteFrameToViewer(clientId: string, data: Uint8Array) {
  const viewer = remoteViewers.get(clientId);
  if (!viewer) return;
  try { viewer.send(data); } catch {}
}

export function hasRemoteViewer(clientId: string): boolean {
  return remoteViewers.has(clientId);
}

export function pingAllRemoteViewers() {
  for (const viewer of remoteViewers.values()) {
    try { viewer.ping(); } catch {}
  }
}

export { encodeMsgpack };
