import { appendFile, mkdir, readFile } from "node:fs/promises";
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

export async function loadHistory(limit = 500): Promise<HistoryMessage[]> {
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
    return messages.slice(-limit);
  } catch {
    return [];
  }
}

export async function appendHistory(message: HistoryMessage): Promise<void> {
  await mkdir(dirname(config.historyPath), { recursive: true });
  await appendFile(config.historyPath, `${JSON.stringify(message)}\n`, "utf8");
}
