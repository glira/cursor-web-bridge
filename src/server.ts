import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { readFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { Readable } from "node:stream";
import { config } from "./config.js";
import {
  checkLoginRateLimit,
  clearLoginRateLimit,
  clearSessionCookie,
  getSessionUser,
  isAuthenticated,
  passwordsMatch,
  requireAuth,
  setSessionCookie,
  validateDisplayName,
} from "./auth.js";
import { runChatTurn, type ChatAttachmentMeta, type ChatImage } from "./agent.js";
import { checkCdpHealth } from "./cdp/bridge.js";
import { storeUploadedFile } from "./uploads.js";
import {
  createFileReadStream,
  downloadFileName,
  extractTmpPaths,
  clearArtifacts,
  listArtifacts,
  registerArtifacts,
  resolveSafeTmpPath,
  zipDirectoryToTemp,
} from "./artifacts.js";
import { appendHistory, clearHistory, deleteHistoryMessage } from "./history.js";
import {
  broadcast,
  buildSnapshot,
  getBusyBy,
  heartbeatPresence,
  isRoomBusy,
  joinRtc,
  leaveRtc,
  listRtcPeers,
  newMessageId,
  publishArtifacts,
  relayRtcSignal,
  setRoomBusy,
  getStreamingMessageId,
  setStreamingMessageId,
  subscribe,
} from "./room.js";
import { apiError, localeFromContext, tApi } from "./locale.js";

const app = new Hono();

app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.get("/", async (c) => {
  const file = isAuthenticated(c) ? "chat.html" : "login.html";
  const html = await readFile(join(config.publicDir, file), "utf8");
  return c.html(html);
});

app.get("/chat", async (c) => {
  if (!isAuthenticated(c)) return c.redirect("/");
  const html = await readFile(join(config.publicDir, "chat.html"), "utf8");
  return c.html(html);
});

app.get("/login", async (c) => {
  if (isAuthenticated(c)) return c.redirect("/chat");
  const html = await readFile(join(config.publicDir, "login.html"), "utf8");
  return c.html(html);
});

app.post("/api/login", async (c) => {
  const limit = checkLoginRateLimit(c);
  if (!limit.ok) {
    c.header("Retry-After", String(limit.retryAfterSec));
    return apiError(c, "too_many_attempts", 429);
  }

  let password = "";
  let displayNameRaw: unknown = "";
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json<{ password?: string; displayName?: string }>();
    password = body.password ?? "";
    displayNameRaw = body.displayName ?? "";
  } else {
    const form = await c.req.parseBody();
    password = typeof form.password === "string" ? form.password : "";
    displayNameRaw = form.displayName;
  }

  const displayName = validateDisplayName(displayNameRaw);
  if (!displayName) {
    return apiError(c, "name_required", 400);
  }

  if (!passwordsMatch(password, config.bridgePassword)) {
    return apiError(c, "invalid_password", 401);
  }

  clearLoginRateLimit(c);
  const session = setSessionCookie(c, { displayName });
  return c.json({
    ok: true,
    clientId: session.clientId,
    displayName: session.displayName,
  });
});

app.post("/api/logout", async (c) => {
  const user = getSessionUser(c);
  if (user) leaveRtc(user.clientId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", (c) => {
  const user = getSessionUser(c);
  return c.json({
    authenticated: Boolean(user),
    backend: config.backend,
    clientId: user?.clientId ?? null,
    displayName: user?.displayName ?? null,
    busy: isRoomBusy(),
    busyBy: getBusyBy(),
    rtc: {
      iceServers: config.rtcIceServers,
      peers: listRtcPeers(),
    },
  });
});

app.post("/api/rtc/join", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  const result = joinRtc({
    clientId: user.clientId,
    displayName: user.displayName,
  });
  return c.json({
    ok: true,
    self: result.self,
    peers: result.peers,
    iceServers: config.rtcIceServers,
  });
});

app.post("/api/rtc/leave", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  leaveRtc(user.clientId);
  return c.json({ ok: true, peers: listRtcPeers() });
});

app.post("/api/rtc/signal", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  let body: {
    toClientId?: string;
    type?: string;
    sdp?: unknown;
    candidate?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  const toClientId = typeof body.toClientId === "string" ? body.toClientId : "";
  const signalType = typeof body.type === "string" ? body.type : "";
  if (!toClientId || !signalType) {
    return apiError(c, "signal_required", 400);
  }
  if (toClientId === user.clientId) {
    return apiError(c, "invalid_destination", 400);
  }
  const ok = relayRtcSignal({
    fromClientId: user.clientId,
    fromDisplayName: user.displayName,
    toClientId,
    payload: {
      type: signalType,
      sdp: body.sdp,
      candidate: body.candidate,
    },
  });
  if (!ok) {
    return apiError(c, "peer_offline", 409);
  }
  return c.json({ ok: true });
});

app.get("/api/health", async (c) => {
  if (config.backend === "cdp") {
    const cdp = await checkCdpHealth();
    return c.json(
      {
        ok: cdp.ok,
        backend: "cdp",
        cdp,
      },
      cdp.ok ? 200 : 503,
    );
  }

  return c.json({
    ok: Boolean(config.cursorApiKey),
    backend: "sdk",
    cwd: config.cursorCwd,
    model: config.cursorModel,
  });
});

app.get("/api/events", requireAuth, async (c) => {
  const user = getSessionUser(c)!;

  return streamSSE(c, async (stream) => {
    let closed = false;
    const send = (event: { type: string; data: unknown; at: number }) => {
      if (closed) return;
      void stream.writeSSE({
        event: event.type,
        data: JSON.stringify(event.data),
      });
    };

    const unsubscribe = subscribe({
      clientId: user.clientId,
      displayName: user.displayName,
      send,
    });

    const snapshot = await buildSnapshot();
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify(snapshot),
    });

    const heartbeat = setInterval(() => {
      heartbeatPresence(user.clientId, user.displayName);
      void stream.writeSSE({
        event: "ping",
        data: JSON.stringify({ t: Date.now() }),
      });
    }, 15_000);

    // Keep the SSE connection open until the client disconnects.
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        resolve();
      };
      c.req.raw.signal.addEventListener("abort", onAbort);
      if (c.req.raw.signal.aborted) onAbort();
    });
  });
});

app.get("/api/artifacts", requireAuth, async (c) => {
  return c.json({ artifacts: await listArtifacts() });
});

app.post("/api/history/clear", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  if (isRoomBusy()) {
    const by = getBusyBy();
    return by
      ? apiError(c, "agent_busy_by", 409, { name: by.displayName })
      : apiError(c, "agent_busy", 409);
  }

  try {
    await clearHistory();
    await clearArtifacts();
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : tApi(localeFromContext(c), "history_clear_failed") },
      500,
    );
  }

  broadcast({
    type: "history_cleared",
    data: { clearedBy: user.displayName, at: Date.now() },
    at: Date.now(),
  });
  console.log(`[history] cleared by=${user.displayName}`);
  return c.json({ ok: true });
});

app.post("/api/history/delete", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  let id = "";
  try {
    const body = await c.req.json<{ id?: string }>();
    id = typeof body.id === "string" ? body.id.trim() : "";
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  if (!id) return apiError(c, "history_id_required", 400);
  if (getStreamingMessageId() === id) {
    return apiError(c, "history_message_in_progress", 409);
  }

  try {
    const result = await deleteHistoryMessage(id);
    if (!result.ok) return apiError(c, "history_message_missing", 404);
  } catch (err) {
    return c.json(
      {
        error:
          err instanceof Error ? err.message : tApi(localeFromContext(c), "history_delete_failed"),
      },
      500,
    );
  }

  broadcast({
    type: "message_deleted",
    data: { id, deletedBy: user.displayName },
    at: Date.now(),
  });
  console.log(`[history] deleted id=${id} by=${user.displayName}`);
  return c.json({ ok: true });
});

app.post("/api/draft", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  let text = "";
  try {
    const body = await c.req.json<{ text?: string }>();
    text = typeof body.text === "string" ? body.text : "";
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  if (text.length > 20_000) {
    return apiError(c, "draft_too_long", 400);
  }
  broadcast({
    type: "composer_draft",
    data: {
      clientId: user.clientId,
      displayName: user.displayName,
      text,
      at: Date.now(),
    },
    at: Date.now(),
  });
  return c.json({ ok: true });
});

app.get("/api/artifacts/download", requireAuth, async (c) => {
  const pathParam = c.req.query("path");
  if (!pathParam) {
    return apiError(c, "path_required", 400);
  }

  try {
    const resolved = await resolveSafeTmpPath(pathParam);
    let filePath = resolved.absolutePath;
    let kind = resolved.kind;
    let downloadName = downloadFileName(filePath, kind);

    if (kind === "dir") {
      filePath = await zipDirectoryToTemp(filePath);
      kind = "file";
      downloadName = basename(filePath);
    }

    const nodeStream = createFileReadStream(filePath);
    const webStream = Readable.toWeb(nodeStream);

    return new Response(webStream as unknown as ReadableStream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${downloadName.replace(/"/g, "")}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : tApi(localeFromContext(c), "download_failed") },
      400,
    );
  }
});

app.post("/api/chat", requireAuth, async (c) => {
  const user = getSessionUser(c)!;

  if (isRoomBusy()) {
    const by = getBusyBy();
    return c.json(
      {
        error: by
          ? tApi(localeFromContext(c), "agent_busy_by", { name: by.displayName })
          : tApi(localeFromContext(c), "agent_busy"),
      },
      409,
    );
  }

  // Claim the room turn immediately to avoid concurrent starters.
  setRoomBusy({ clientId: user.clientId, displayName: user.displayName });
  console.log(
    `[chat] turn start by=${user.displayName} clientId=${user.clientId.slice(0, 8)}…`,
  );

  const contentType = c.req.header("content-type") || "";
  let text = "";
  const images: ChatImage[] = [];
  const attachments: ChatAttachmentMeta[] = [];

  try {
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      text = typeof body.text === "string" ? body.text : "";

      const filesRaw = body.files;
      const files: File[] = [];
      if (filesRaw instanceof File) files.push(filesRaw);
      else if (Array.isArray(filesRaw)) {
        for (const item of filesRaw) {
          if (item instanceof File) files.push(item);
        }
      }

      for (const file of files) {
        const stored = await storeUploadedFile(file);
        attachments.push(stored.meta);
        if (stored.image) images.push(stored.image);
      }
    } else {
      const body = await c.req.json<{
        text?: string;
        images?: ChatImage[];
        attachments?: ChatAttachmentMeta[];
      }>();
      text = body.text ?? "";
      if (Array.isArray(body.images)) images.push(...body.images);
      if (Array.isArray(body.attachments)) attachments.push(...body.attachments);
    }
  } catch (err) {
    setRoomBusy(null);
    return c.json({ error: err instanceof Error ? err.message : tApi(localeFromContext(c), "invalid_payload") }, 400);
  }

  const preview =
    text.trim() +
    (attachments.length
      ? `${text.trim() ? "\n\n" : ""}${tApi(localeFromContext(c), "attachments_prefix", {
          names: attachments.map((a) => a.originalName).join(", "),
        })}`
      : "");

  if (!preview.trim() && images.length === 0) {
    setRoomBusy(null);
    return apiError(c, "text_or_file", 400);
  }

  const userMessageId = newMessageId();
  const turnStartedAt = Date.now();
  const userMessage = {
    id: userMessageId,
    role: "user" as const,
    text: preview || tApi(localeFromContext(c), "image_only"),
    displayName: user.displayName,
    clientId: user.clientId,
    createdAt: turnStartedAt,
  };
  await appendHistory(userMessage);
  broadcast({ type: "user_message", data: userMessage, at: Date.now() });

  const assistantMessageId = newMessageId();
  setStreamingMessageId(assistantMessageId);

  // Announce streaming assistant shell so clients can show meta + elapsed.
  broadcast({
    type: "assistant_token",
    data: {
      messageId: assistantMessageId,
      text: "",
      startedAt: turnStartedAt,
      startedBy: user.displayName,
      running: true,
    },
    at: Date.now(),
  });

  let assistantText = "";
  const seenPaths = new Set<string>();

  const registerFromText = async (chunk: string) => {
    const paths = extractTmpPaths(chunk);
    const fresh = paths.filter((p) => !seenPaths.has(p));
    for (const p of fresh) seenPaths.add(p);
    if (fresh.length === 0) return;
    const created = await registerArtifacts(fresh);
    if (created.length) publishArtifacts(created, { messageId: assistantMessageId });
  };

  try {
    broadcast({
      type: "status",
      data: { message: `Turno iniciado por ${user.displayName}`, messageId: assistantMessageId },
      at: Date.now(),
    });

    const result = await runChatTurn({
      text,
      images,
      attachments,
      handlers: {
        onText: (chunk) => {
          assistantText += chunk;
          broadcast({
            type: "assistant_token",
            data: {
              messageId: assistantMessageId,
              text: chunk,
              startedAt: turnStartedAt,
              startedBy: user.displayName,
              running: true,
            },
            at: Date.now(),
          });
          void registerFromText(chunk);
        },
        onReplace: (fullText) => {
          assistantText = fullText;
          broadcast({
            type: "assistant_replace",
            data: {
              messageId: assistantMessageId,
              text: fullText,
              startedAt: turnStartedAt,
              startedBy: user.displayName,
              running: true,
            },
            at: Date.now(),
          });
          void registerFromText(fullText);
        },
        onStatus: (message) => {
          broadcast({
            type: "status",
            data: { message, messageId: assistantMessageId },
            at: Date.now(),
          });
        },
        onActivity: (lines) => {
          broadcast({
            type: "agent_activity",
            data: {
              lines,
              messageId: assistantMessageId,
              startedAt: turnStartedAt,
              elapsedMs: Date.now() - turnStartedAt,
            },
            at: Date.now(),
          });
        },
      },
    });

    await registerFromText(assistantText);

    const completedAt = Date.now();
    const artifactPaths = [...seenPaths];
    const assistantMessage = {
      id: assistantMessageId,
      role: "assistant" as const,
      text: assistantText || tApi(localeFromContext(c), "finished", { status: result.status || "ok" }),
      createdAt: turnStartedAt,
      completedAt,
      durationMs: completedAt - turnStartedAt,
      startedBy: user.displayName,
      status: result.status || "finished",
      artifactPaths,
    };
    await appendHistory(assistantMessage);
    broadcast({
      type: "assistant_done",
      data: {
        message: assistantMessage,
        result,
      },
      at: Date.now(),
    });

    return c.json({ ok: true, messageId: assistantMessageId, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : tApi(localeFromContext(c), "unknown_error");
    const completedAt = Date.now();
    if (assistantText.trim() || seenPaths.size > 0) {
      const partial = {
        id: assistantMessageId,
        role: "assistant" as const,
        text: assistantText || tApi(localeFromContext(c), "error_wrap", { message }),
        createdAt: turnStartedAt,
        completedAt,
        durationMs: completedAt - turnStartedAt,
        startedBy: user.displayName,
        status: "error",
        artifactPaths: [...seenPaths],
      };
      await appendHistory(partial);
      broadcast({
        type: "assistant_done",
        data: { message: partial, result: { status: "error" } },
        at: Date.now(),
      });
    }
    broadcast({
      type: "room_error",
      data: { error: message, messageId: assistantMessageId },
      at: Date.now(),
    });
    return c.json({ error: message }, 500);
  } finally {
    setStreamingMessageId(null);
    setRoomBusy(null);
    console.log(
      `[chat] turn end messageId=${assistantMessageId} by=${user.displayName}`,
    );
  }
});

app.post("/api/upload", requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const filesRaw = body.file ?? body.files;
    const files: File[] = [];
    if (filesRaw instanceof File) files.push(filesRaw);
    else if (Array.isArray(filesRaw)) {
      for (const item of filesRaw) {
        if (item instanceof File) files.push(item);
      }
    }
    if (files.length === 0) {
      return apiError(c, "no_file", 400);
    }

    const stored = [];
    for (const file of files) {
      stored.push(await storeUploadedFile(file));
    }
    return c.json({
      files: stored.map((s) => ({
        ...s.meta,
        hasImagePayload: Boolean(s.image),
      })),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : tApi(localeFromContext(c), "upload_failed") }, 400);
  }
});

const publicRelative = relative(process.cwd(), config.publicDir) || "public";
app.use(
  "/*",
  serveStatic({
    root: publicRelative,
  }),
);

console.log(`[bridge] backend -> ${config.backend}`);
if (config.backend === "cdp") {
  console.log(`[bridge] cdp -> ${config.cursorCdpUrl}`);
} else {
  console.log(`[bridge] cwd agent -> ${config.cursorCwd}`);
}
console.log(`[bridge] starting on http://127.0.0.1:${config.port}`);
console.log(`[bridge] health: http://127.0.0.1:${config.port}/api/health`);
console.log(`[bridge] then: ./start-local.sh  (or: cloudflared / ngrok http ${config.port})`);

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
    hostname: "0.0.0.0",
  },
  () => {
    console.log(`[bridge] listening on http://127.0.0.1:${config.port}`);
  },
);

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[bridge] port ${config.port} already in use. Change PORT in .env or stop the other process.`,
    );
  } else {
    console.error("[bridge] server error:", err);
  }
  process.exit(1);
});

