import { config as loadEnv } from "dotenv";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

loadEnv();

const rootDir = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

const backendRaw = (process.env.BRIDGE_BACKEND || "cdp").trim().toLowerCase();
const backend = backendRaw === "sdk" ? "sdk" : "cdp";

const cursorCwd = resolve(process.env.CURSOR_CWD || process.cwd());

export const config = {
  rootDir,
  port: Number(process.env.PORT || 8787),
  bridgePassword: required("BRIDGE_PASSWORD"),
  sessionSecret: required("BRIDGE_SESSION_SECRET"),
  backend: backend as "cdp" | "sdk",
  cursorApiKey: optional("CURSOR_API_KEY") || "",
  cursorCwd,
  cursorModel: process.env.CURSOR_MODEL?.trim() || "composer-2.5",
  cursorCdpUrl: (process.env.CURSOR_CDP_URL || "http://127.0.0.1:9222").replace(/\/$/, ""),
  // Prefer Cursor window whose title/workspace matches this (default: pasta do CURSOR_CWD).
  cursorCdpTarget: (optional("CURSOR_CDP_TARGET") || basename(cursorCwd)).toLowerCase(),
  cdpPollMs: Number(process.env.CDP_POLL_MS || 400),
  // Soft window / extension slice while the agent is active (not a hard wall).
  cdpTimeoutMs: Number(process.env.CDP_TIMEOUT_MS || 600_000),
  // Absolute cap for a single CDP turn (default 45 min).
  cdpMaxTimeoutMs: Number(process.env.CDP_MAX_TIMEOUT_MS || 2_700_000),
  dataDir: resolve(rootDir, "data"),
  // Inside the agent cwd so local tools can read attachments.
  uploadsDir: resolve(cursorCwd, ".cursor-web-bridge-uploads"),
  publicDir: resolve(rootDir, "public"),
  agentIdPath: resolve(rootDir, "data", "agent-id.json"),
  historyPath: resolve(rootDir, "data", "room-history.jsonl"),
  artifactsPath: resolve(rootDir, "data", "artifacts.json"),
  cookieName: "bridge_session",
  maxUploadBytes: 10 * 1024 * 1024,
  rtcIceServers: buildIceServers(),
};

function buildIceServers(): Array<{
  urls: string | string[];
  username?: string;
  credential?: string;
}> {
  const stun = (process.env.RTC_STUN_URLS || "stun:stun.l.google.com:19302")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const servers: Array<{ urls: string | string[]; username?: string; credential?: string }> = [];
  if (stun.length) servers.push({ urls: stun.length === 1 ? stun[0]! : stun });

  const turnUrls = (process.env.RTC_TURN_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const turnUser = optional("RTC_TURN_USER");
  const turnPass = optional("RTC_TURN_PASS");
  if (turnUrls.length && turnUser && turnPass) {
    servers.push({
      urls: turnUrls.length === 1 ? turnUrls[0]! : turnUrls,
      username: turnUser,
      credential: turnPass,
    });
  }
  return servers;
}

if (config.backend === "sdk" && !config.cursorApiKey) {
  throw new Error("BRIDGE_BACKEND=sdk requer CURSOR_API_KEY");
}

export type BridgeConfig = typeof config;
