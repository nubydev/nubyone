import { ansiToHtml } from "./ansi.js";
import { encodeMsgpack, decodeMsgpack } from "./msgpack-helpers.js";
const outputEl = document.getElementById("console-output");
const statusPill = document.getElementById("status-pill");
const clientLabel = document.getElementById("client-label");
const hostLabel = document.getElementById("host-label");
const userLabel = document.getElementById("user-label");
const osLabel = document.getElementById("os-label");
const form = document.getElementById("console-form");
const input = document.getElementById("console-input");
const ctrlcBtn = document.getElementById("ctrlc-btn");

const clientId = decodeURIComponent(
  location.pathname.split("/").filter(Boolean)[0] || "",
);
const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = `${wsProto}://${location.host}/api/clients/${encodeURIComponent(clientId)}/console/ws`;
let ws = null;
let connected = false;
let outputBuffer = "";
let hasOutput = false;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 30000;
let manualClose = false;

const urlParams = new URLSearchParams(window.location.search);
const prefilledCommand = urlParams.get("cmd");
if (prefilledCommand && input) {
  setTimeout(() => {
    input.value = prefilledCommand;
    input.focus();
  }, 1000);
}

function setStatus(label, tone = "pill-offline") {
  if (!statusPill) return;
  statusPill.className = `pill ${tone}`;
  statusPill.innerHTML = `<i class="fa-solid fa-circle"></i> ${label}`;
}

function appendSystem(text) {
  outputBuffer += `\n[system] ${text}\n`;
  renderOutput();
}

function appendOutput(text) {
  outputBuffer += text;
  renderOutput();
}

function renderOutput() {
  if (!outputEl) return;
  const normalized = outputBuffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  outputEl.innerHTML = `<pre class="console-pre">${ansiToHtml(normalized)}</pre>`;
  outputEl.scrollTop = outputEl.scrollHeight;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(encodeMsgpack({ type: "ping", ts: Date.now() }));
      } catch {}
    }
  }, 20000);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || manualClose) return;
  const delay = Math.min(1000 * Math.pow(1.5, reconnectAttempts), MAX_RECONNECT_DELAY_MS);
  reconnectAttempts++;
  setStatus(`Reconnecting in ${Math.round(delay / 1000)}s…`, "pill-offline");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  appendSystem("Connecting to console...");
  setStatus("Connecting...", "pill-offline");
  ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("open", () => {
    connected = true;
    reconnectAttempts = 0;
    setStatus("Connected", "pill-online");
    startHeartbeat();
  });

  ws.addEventListener("message", (event) => {
    const payload = decodeMsgpack(event.data);
    if (!payload) return;

    switch (payload.type) {
      case "pong":
        break;
      case "ready":
        if (clientLabel) clientLabel.textContent = payload.clientId || "unknown";
        if (hostLabel) hostLabel.textContent = payload.host || "unknown";
        if (userLabel) userLabel.textContent = payload.user || "unknown";
        if (osLabel) osLabel.textContent = payload.os || "unknown";
        setStatus("Connected", "pill-online");
        break;
      case "status":
        if (payload.status === "offline") {
          setStatus("Offline", "pill-offline");
          appendSystem(payload.reason || "Client offline");
        } else if (payload.status === "connecting" && !hasOutput) {
          setStatus("Connecting...", "pill-ghost");
        } else if (payload.status === "closed") {
          setStatus("Closed", "pill-offline");
          appendSystem(payload.reason || "Console closed");
        }
        break;
      case "output": {
        if (payload.data) {
          hasOutput = true;
          setStatus("Live", "pill-online");
          appendOutput(payload.data);
        }
        if (payload.error) appendSystem(payload.error);
        if (typeof payload.exitCode === "number") {
          appendSystem(`Process exited (${payload.exitCode})`);
          setStatus("Closed", "pill-offline");
        }
        break;
      }
      default:
        break;
    }
  });

  ws.addEventListener("close", () => {
    const wasConnected = connected;
    connected = false;
    stopHeartbeat();
    if (manualClose) return;
    if (wasConnected) {
      setStatus("Disconnected — reconnecting", "pill-offline");
      appendSystem("Connection lost — reconnecting...");
    }
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    setStatus("Error", "pill-offline");
  });
}

function sendInput(value) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    appendSystem("Socket not ready");
    return;
  }
  ws.send(encodeMsgpack({ type: "input", data: value }));
}

function wireInput() {
  if (!form || !input) return;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value;
    if (!value.trim()) {
      input.value = "";
      return;
    }
    const text = value.endsWith("\n") ? value : `${value}\n`;
    sendInput(text);
    input.value = "";
    input.focus();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      form.dispatchEvent(new Event("submit"));
    }
  });

  ctrlcBtn?.addEventListener("click", () => {
    sendInput("\u0003");
  });
}
wireInput();
connect();
