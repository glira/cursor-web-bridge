import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";

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

async function loadAllHistory(): Promise<HistoryMessage[]> {
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
    return messages;
  } catch {
    return [];
  }
}

export async function loadHistory(limit = 500): Promise<HistoryMessage[]> {
  const messages = await loadAllHistory();
  return messages.slice(-limit);
}

export async function appendHistory(message: HistoryMessage): Promise<void> {
  await mkdir(dirname(config.historyPath), { recursive: true });
  await appendFile(config.historyPath, `${JSON.stringify(message)}\n`, "utf8");
}

/** Wipe the Bridge room transcript only. Does not touch the Cursor IDE chat. */
export async function clearHistory(): Promise<void> {
  await mkdir(dirname(config.historyPath), { recursive: true });
  await writeFile(config.historyPath, "", "utf8");
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
  return { ok: true, message };
}
