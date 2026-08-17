import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Agent, CursorAgentError, type SDKAgent } from "@cursor/sdk";
import { config } from "./config.js";
import { runCdpChatTurn } from "./cdp/bridge.js";
import type { StreamHandlers } from "./types.js";

export type { StreamHandlers } from "./types.js";

export type ChatImage = {
  data: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
};

export type ChatAttachmentMeta = {
  originalName: string;
  absolutePath: string;
  mimeType: string;
  kind: "image" | "file";
};

type PersistedAgent = { agentId: string };

let agentHandle: SDKAgent | null = null;
let agentBusy = false;

async function loadPersistedAgentId(): Promise<string | null> {
  try {
    const raw = await readFile(config.agentIdPath, "utf8");
    const parsed = JSON.parse(raw) as PersistedAgent;
    return typeof parsed.agentId === "string" && parsed.agentId ? parsed.agentId : null;
  } catch {
    return null;
  }
}

async function persistAgentId(agentId: string): Promise<void> {
  await mkdir(dirname(config.agentIdPath), { recursive: true });
  const payload: PersistedAgent = { agentId };
  await writeFile(config.agentIdPath, JSON.stringify(payload, null, 2), "utf8");
}

async function ensureAgent(): Promise<SDKAgent> {
  if (agentHandle) return agentHandle;

  const existingId = await loadPersistedAgentId();
  if (existingId) {
    try {
      agentHandle = await Agent.resume(existingId, {
        apiKey: config.cursorApiKey,
        model: { id: config.cursorModel },
        local: { cwd: config.cursorCwd },
      });
      console.log(`[agent] resumed ${agentHandle.agentId}`);
      return agentHandle;
    } catch (err) {
      console.warn("[agent] resume failed, creating new agent:", err instanceof Error ? err.message : err);
    }
  }

  agentHandle = await Agent.create({
    apiKey: config.cursorApiKey,
    model: { id: config.cursorModel },
    local: { cwd: config.cursorCwd },
  });
  await persistAgentId(agentHandle.agentId);
  console.log(`[agent] created ${agentHandle.agentId}`);
  return agentHandle;
}

function buildPrompt(text: string, attachments: ChatAttachmentMeta[]): string {
  const fileLines = attachments
    .filter((a) => a.kind === "file")
    .map((a) => `- ${a.originalName} (${a.mimeType}): ${a.absolutePath}`);

  if (fileLines.length === 0) return text;

  const header =
    "O usuário anexou arquivo(s). Leia o conteúdo pelo(s) caminho(s) absoluto(s) abaixo e responda considerando o texto e os anexos.\n" +
    fileLines.join("\n");

  if (!text.trim()) return header;
  return `${text.trim()}\n\n${header}`;
}

export async function runChatTurn(opts: {
  text: string;
  images: ChatImage[];
  attachments: ChatAttachmentMeta[];
  handlers: StreamHandlers;
}): Promise<{ agentId: string; runId: string; status: string }> {
  if (agentBusy) {
    throw new Error("Já existe uma resposta em andamento. Aguarde terminar.");
  }

  agentBusy = true;
  try {
    if (config.backend === "cdp") {
      const prompt = buildPrompt(opts.text, opts.attachments);
      if (!prompt.trim()) {
        throw new Error("Envie texto (modo CDP ainda não envia imagens pelo painel).");
      }
      if (opts.images.length > 0) {
        opts.handlers.onStatus("cdp: imagens ignoradas neste modo");
      }
      return await runCdpChatTurn({ text: prompt, handlers: opts.handlers });
    }

    const agent = await ensureAgent();
    const prompt = buildPrompt(opts.text, opts.attachments);
    if (!prompt.trim() && opts.images.length === 0) {
      throw new Error("Envie texto e/ou arquivo.");
    }

    opts.handlers.onStatus(`agent=${agent.agentId}`);

    const message =
      opts.images.length > 0
        ? {
            text: prompt || "Analise a(s) imagem(ns) anexada(s).",
            images: opts.images,
          }
        : prompt;

    const run = await agent.send(message, {
      model: { id: config.cursorModel },
    });

    console.log(`[agent] run started agentId=${agent.agentId} runId=${run.id}`);

    for await (const event of run.stream()) {
      if (event.type === "assistant") {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            opts.handlers.onText(block.text);
          }
        }
        continue;
      }

      if (event.type === "tool_call") {
        const name = "name" in event && typeof event.name === "string" ? event.name : "tool";
        const status =
          "status" in event && typeof event.status === "string" ? event.status : "running";
        opts.handlers.onActivity?.([`${name} (${status})`]);
        continue;
      }

      if (event.type === "thinking") {
        opts.handlers.onActivity?.(["Thinking…"]);
        continue;
      }

      if (event.type === "status") {
        const status =
          "status" in event && typeof event.status === "string" ? event.status : "RUNNING";
        opts.handlers.onActivity?.([`Status: ${status}`]);
      }
    }

    opts.handlers.onActivity?.([]);

    const result = await run.wait();
    return {
      agentId: agent.agentId,
      runId: run.id,
      status: result.status,
    };
  } catch (err) {
    if (err instanceof CursorAgentError) {
      throw new Error(`Falha ao iniciar o agente: ${err.message}`);
    }
    throw err;
  } finally {
    agentBusy = false;
  }
}

export async function resetAgentSession(): Promise<void> {
  if (agentHandle) {
    try {
      await agentHandle[Symbol.asyncDispose]();
    } catch {
      // ignore dispose errors
    }
    agentHandle = null;
  }
  await mkdir(dirname(config.agentIdPath), { recursive: true });
  await writeFile(config.agentIdPath, JSON.stringify({ agentId: null }, null, 2), "utf8");
}
