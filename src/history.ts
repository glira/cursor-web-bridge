import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";

export const HISTORY_PAGE = 40;
export const HISTORY_PAGE_MAX = 80;

export type HistoryMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  displayName?: string;
  clientId?: string;
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  startedBy?: string;
  status?: string;
  artifactPaths?: string[];
};

export type HistoryPage = {
  messages: HistoryMessage[];
  hasMore: boolean;
};

let cache: HistoryMessage[] | null = null;

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : HISTORY_PAGE;
  return Math.min(HISTORY_PAGE_MAX, Math.max(1, n));
}

async function loadAllHistory(): Promise<HistoryMessage[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(config.historyPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const messages: HistoryMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as HistoryMessage;
        if (parsed && typeof parsed.id === "string" && typeof parsed.text === "string") {
          messages.push(parsed);
        }
      } catch {
        // skip bad lines
      }
    }
    cache = messages;
    return cache;
  } catch {
    cache = [];
    return cache;
  }
}

export async function loadHistoryPage(opts: {
  limit?: number;
  beforeId?: string;
} = {}): Promise<HistoryPage | { error: "unknown_before" }> {
  const limit = clampLimit(opts.limit);
  const all = await loadAllHistory();
  const beforeId = opts.beforeId?.trim() || "";

  if (beforeId) {
    const index = all.findIndex((message) => message.id === beforeId);
    if (index < 0) return { error: "unknown_before" };
    const start = Math.max(0, index - limit);
    return {
      messages: all.slice(start, index),
      hasMore: start > 0,
    };
  }

  const start = Math.max(0, all.length - limit);
  return {
    messages: all.slice(start),
    hasMore: start > 0,
  };
}

export async function loadHistory(limit = HISTORY_PAGE): Promise<HistoryMessage[]> {
  const page = await loadHistoryPage({ limit });
  if ("error" in page) return [];
  return page.messages;
}

export async function appendHistory(message: HistoryMessage): Promise<void> {
  await mkdir(dirname(config.historyPath), { recursive: true });
  await appendFile(config.historyPath, `${JSON.stringify(message)}\n`, "utf8");
  if (cache) cache.push(message);
}

/** Wipe the Bridge room transcript only. Does not touch the Cursor IDE chat. */
export async function clearHistory(): Promise<void> {
  await mkdir(dirname(config.historyPath), { recursive: true });
  await writeFile(config.historyPath, "", "utf8");
  cache = [];
}

/** Remove one Bridge message. Does not touch the Cursor IDE chat. */
export async function deleteHistoryMessage(
  id: string,
): Promise<{ ok: true; message: HistoryMessage } | { ok: false }> {
  const messages = await loadAllHistory();
  const index = messages.findIndex((m) => m.id === id);
  if (index < 0) return { ok: false };
  const [message] = messages.splice(index, 1);
  await mkdir(dirname(config.historyPath), { recursive: true });
  const body = messages.map((m) => `${JSON.stringify(m)}\n`).join("");
  await writeFile(config.historyPath, body, "utf8");
  cache = messages;
  return { ok: true, message };
}
