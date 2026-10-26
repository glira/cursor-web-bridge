import { appendFile, mkdir, open, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

const caches = new Map<string, HistoryMessage[]>();

export function historyFile(roomId: string): string {
  return join(config.dataDir, "rooms", roomId, "history.jsonl");
}

export async function migrateLegacyHistory(): Promise<void> {
  const dest = historyFile("geral");
  try {
    await readFile(dest, "utf8");
    return;
  } catch {
    // not migrated yet
  }
  try {
    await mkdir(dirname(dest), { recursive: true });
    await rename(config.historyPath, dest);
    console.log("[history] migrated legacy transcript to the general tab");
  } catch {
    // no legacy file
  }
}

function clampLimit(limit: number | undefined): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : HISTORY_PAGE;
  return Math.min(HISTORY_PAGE_MAX, Math.max(1, n));
}

async function loadAllHistory(roomId: string): Promise<HistoryMessage[]> {
  const cached = caches.get(roomId);
  if (cached) return cached;
  try {
    const raw = await readFile(historyFile(roomId), "utf8");
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
    caches.set(roomId, messages);
    return messages;
  } catch {
    const empty: HistoryMessage[] = [];
    caches.set(roomId, empty);
    return empty;
  }
}

export async function loadHistoryPage(
  roomId: string,
  opts: {
    limit?: number;
    beforeId?: string;
  } = {},
): Promise<HistoryPage | { error: "unknown_before" }> {
  const limit = clampLimit(opts.limit);
  const all = await loadAllHistory(roomId);
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

export async function loadHistory(roomId: string, limit = HISTORY_PAGE): Promise<HistoryMessage[]> {
  const page = await loadHistoryPage(roomId, { limit });
  if ("error" in page) return [];
  return page.messages;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/** Roll back a failed append so a half-written line cannot stick to the next one. */
async function rollbackAppend(path: string, size: number): Promise<void> {
  try {
    await truncate(path, size);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export async function appendHistory(roomId: string, message: HistoryMessage): Promise<void> {
  const path = historyFile(roomId);
  await mkdir(dirname(path), { recursive: true });
  let sizeBefore = await fileSize(path);
  if (sizeBefore > 0) {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, sizeBefore - 1);
      if (buf[0] !== 0x0a) {
        try {
          await appendFile(path, "\n", "utf8");
        } catch (err) {
          await rollbackAppend(path, sizeBefore);
          throw err;
        }
        sizeBefore += 1;
      }
    } finally {
      await fh.close();
    }
  }
  try {
    await appendFile(path, `${JSON.stringify(message)}\n`, "utf8");
  } catch (err) {
    await rollbackAppend(path, sizeBefore);
    throw err;
  }
  const cache = caches.get(roomId);
  if (cache) cache.push(message);
}

/** Wipe the Bridge room transcript only. Does not touch the Cursor IDE chat. */
export async function clearHistory(roomId: string): Promise<void> {
  const path = historyFile(roomId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", "utf8");
  caches.set(roomId, []);
}

/** Remove one Bridge message. Does not touch the Cursor IDE chat. */
export async function deleteHistoryMessage(
  roomId: string,
  id: string,
): Promise<{ ok: true; message: HistoryMessage } | { ok: false }> {
  const messages = await loadAllHistory(roomId);
  const index = messages.findIndex((m) => m.id === id);
  if (index < 0) return { ok: false };
  const [message] = messages.splice(index, 1);
  const path = historyFile(roomId);
  await mkdir(dirname(path), { recursive: true });
  const body = messages.map((m) => `${JSON.stringify(m)}\n`).join("");
  await writeFile(path, body, "utf8");
  caches.set(roomId, messages);
  return { ok: true, message };
}
