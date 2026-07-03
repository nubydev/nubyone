import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { getDataDir } from "./config";

export interface NotificationConfig {
  discordWebhookUrl: string;
  telegramBotToken: string;
  telegramChatId: string;
  notifyOnConnect: boolean;
  notifyOnDisconnect: boolean;
}

function getConfigFile(): string {
  return path.join(getDataDir(), "notification-config.json");
}

const DEFAULT: NotificationConfig = {
  discordWebhookUrl: "",
  telegramBotToken: "",
  telegramChatId: "",
  notifyOnConnect: true,
  notifyOnDisconnect: false,
};

export function loadNotificationConfig(): NotificationConfig {
  try {
    const configFile = getConfigFile();
    if (existsSync(configFile)) {
      return { ...DEFAULT, ...JSON.parse(readFileSync(configFile, "utf8")) };
    }
  } catch {}
  return { ...DEFAULT };
}

export function saveNotificationConfig(partial: Partial<NotificationConfig>): NotificationConfig {
  const configFile = getConfigFile();
  mkdirSync(path.dirname(configFile), { recursive: true });
  const merged = { ...loadNotificationConfig(), ...partial };
  writeFileSync(configFile, JSON.stringify(merged, null, 2));
  return merged;
}

// ── Discord ────────────────────────────────────────────────────────────────────
//
// With screenshot: multipart/form-data — embed with image reference + the JPEG
// as an attachment. Discord renders the image inline inside the embed.
// Without screenshot: plain JSON { content }.
async function postDiscord(url: string, content: string, screenshotB64?: string): Promise<void> {
  if (!url) return;
  try {
    let res: Response;
    if (screenshotB64) {
      // Build multipart: payload_json embeds the image via "attachment://screenshot.jpg"
      // so it renders inline below the text inside a single embed — not as a separate
      // message or a dangling file.
      const embed = {
        color: 0x22c55e, // green
        description: content,
        image: { url: "attachment://screenshot.jpg" },
      };
      const form = new FormData();
      form.set("payload_json", JSON.stringify({ embeds: [embed] }));
      const imgBytes = Buffer.from(screenshotB64, "base64");
      form.set("files[0]", new Blob([imgBytes], { type: "image/jpeg" }), "screenshot.jpg");
      res = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(10_000) });
    } else {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!res.ok) console.warn(`[notifier] Discord webhook returned HTTP ${res.status}`);
  } catch (e) {
    console.error("[notifier] Discord webhook error:", e);
  }
}

// ── Telegram ───────────────────────────────────────────────────────────────────
//
// With screenshot: sendPhoto — image + caption in one message, caption rendered
// with Markdown. Without screenshot: sendMessage as before.
async function postTelegram(token: string, chatId: string, text: string, screenshotB64?: string): Promise<void> {
  if (!token || !chatId) return;
  try {
    let res: Response;
    if (screenshotB64) {
      const form = new FormData();
      form.set("chat_id", chatId);
      form.set("caption", text);
      form.set("parse_mode", "Markdown");
      const imgBytes = Buffer.from(screenshotB64, "base64");
      form.set("photo", new Blob([imgBytes], { type: "image/jpeg" }), "screenshot.jpg");
      res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[notifier] Telegram returned HTTP ${res.status}: ${body}`);
    }
  } catch (e) {
    console.error("[notifier] Telegram error:", e);
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

export interface AgentEventInfo {
  host: string;
  os: string;
  username: string;
  ip: string;
  buildTag?: string;
  /** Base64-encoded JPEG screenshot, captured at connect time (optional). */
  screenshotB64?: string;
}

export async function notifyAgentConnect(info: AgentEventInfo): Promise<void> {
  const cfg = loadNotificationConfig();
  if (!cfg.notifyOnConnect) return;
  if (!cfg.discordWebhookUrl && !(cfg.telegramBotToken && cfg.telegramChatId)) return;

  const tag = info.buildTag ? ` [${info.buildTag}]` : "";
  const discord = [
    `🟢 **Agent Connected**${tag}`,
    `> **Host:** ${info.host}`,
    `> **OS:** ${info.os}`,
    `> **User:** ${info.username}`,
    `> **IP:** ${info.ip}`,
  ].join("\n");
  const telegram = [
    `🟢 *Agent Connected*${tag}`,
    `*Host:* \`${info.host}\``,
    `*OS:* ${info.os}`,
    `*User:* ${info.username}`,
    `*IP:* \`${info.ip}\``,
  ].join("\n");

  await Promise.all([
    postDiscord(cfg.discordWebhookUrl, discord, info.screenshotB64),
    postTelegram(cfg.telegramBotToken, cfg.telegramChatId, telegram, info.screenshotB64),
  ]);
}

export async function notifyAgentDisconnect(info: { host: string }): Promise<void> {
  const cfg = loadNotificationConfig();
  if (!cfg.notifyOnDisconnect) return;
  if (!cfg.discordWebhookUrl && !(cfg.telegramBotToken && cfg.telegramChatId)) return;

  const discord = `🔴 **Agent Disconnected**\n> **Host:** ${info.host}`;
  const telegram = `🔴 *Agent Disconnected*\n*Host:* \`${info.host}\``;

  await Promise.all([
    postDiscord(cfg.discordWebhookUrl, discord),
    postTelegram(cfg.telegramBotToken, cfg.telegramChatId, telegram),
  ]);
}
