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
  requireAdmin,
  requireAuth,
  setSessionCookie,
  validateDisplayName,
} from "./auth.js";
import { runChatTurn, type ChatAttachmentMeta, type ChatImage } from "./agent.js";
import { checkCdpHealth, clickDecision, cursorWindowOpen } from "./cdp/bridge.js";
import { storeUploadedFile } from "./uploads.js";
import {
  createFileReadStream,
  downloadFileName,
  extractTmpBasenameCandidates,
  extractTmpPaths,
  filterExistingTmpPaths,
  clearArtifacts,
  listArtifacts,
  registerArtifacts,
  resolveSafeTmpPath,
  zipDirectoryToTemp,
} from "./artifacts.js";
import {
  appendHistory,
  clearHistory,
  deleteHistoryMessage,
  HISTORY_PAGE,
  loadHistoryPage,
} from "./history.js";
import {
  broadcast,
  buildSnapshot,
  claimDecision,
  clearPendingDecision,
  getBusyBy,
  getPendingDecision,
  heartbeatPresence,
  isRoomBusy,
  joinRtc,
  leaveRtc,
  listRtcPeers,
  newMessageId,
  publishArtifacts,
  relayRtcSignal,
  releaseDecisionClaim,
  setPendingDecision,
  setRoomBusy,
  getStreamingMessageId,
  setStreamingMessageId,
  touchRoomActivity,
  subscribe,
  subscribeStatus,
} from "./room.js";
import { apiError, localeFromContext, tApi } from "./locale.js";
import {
  createUser,
  deleteUser,
  findUserByUsername,
  GENERAL_ROOM_ID,
  getRoom,
  initStore,
  listRooms,
  listUsers,
  verifyPassword,
  type RoomRecord,
} from "./store.js";
import {
  checkCapacity,
  createWorkspace,
  deleteWorkspace,
  ensureAllWindows,
  ensureRoomWindow,
  prepareWorkspaceBase,
  startIdleWindowCloser,
  type Capacity,
} from "./workspaces.js";

const app = new Hono();

function isResponse(value: RoomRecord | Response): value is Response {
  return value instanceof Response;
}

async function readyRoom(c: Parameters<typeof apiError>[0], roomId: string): Promise<RoomRecord | Response> {
  const id = roomId.trim() || GENERAL_ROOM_ID;
  const room = await getRoom(id);
  if (!room) return apiError(c, "room_unknown", 404);
  if (room.status !== "ready") return apiError(c, "room_not_ready", 409);
  return room;
}

function capacityBody(error: unknown): { error: string; capacity?: Capacity } | null {
  if (!(error instanceof Error)) return null;
  if (error.message !== "workspace_blocked" && error.message !== "workspace_warn") return null;
  const capacity = (error as Error & { capacity?: Capacity }).capacity;
  return { error: error.message, capacity };
}

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
  let usernameRaw = "";
  const contentType = c.req.header("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json<{ password?: string; username?: string }>();
    password = body.password ?? "";
    usernameRaw = body.username ?? "";
  } else {
    const form = await c.req.parseBody();
    password = typeof form.password === "string" ? form.password : "";
    usernameRaw = typeof form.username === "string" ? form.username : "";
  }

  const account = await findUserByUsername(usernameRaw);
  if (!account || !(await verifyPassword(account.passwordHash, password))) {
    return apiError(c, "invalid_login", 401);
  }

  clearLoginRateLimit(c);
  const session = setSessionCookie(c, {
    userId: account.id,
    role: account.role,
    displayName: account.displayName,
  });
  return c.json({
    ok: true,
    clientId: session.clientId,
    displayName: session.displayName,
    role: session.role,
  });
});

app.post("/api/logout", async (c) => {
  const user = getSessionUser(c);
  if (user) leaveRtc(user.clientId);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

app.get("/api/me", async (c) => {
  const user = getSessionUser(c);
  const requested = (c.req.query("room") || GENERAL_ROOM_ID).trim() || GENERAL_ROOM_ID;
  const room = user ? await getRoom(requested) : null;
  const active = room && room.status === "ready" ? room : null;
  const rooms = user ? await listRooms() : [];
  return c.json({
    authenticated: Boolean(user),
    backend: config.backend,
    clientId: user?.clientId ?? null,
    userId: user?.userId ?? null,
    role: user?.role ?? null,
    displayName: user?.displayName ?? null,
    room: active?.id ?? null,
    busy: active ? isRoomBusy(active.id) : false,
    busyBy: active ? getBusyBy(active.id) : null,
    pendingDecision: active ? getPendingDecision(active.id) : null,
    rooms: rooms.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      statusError: item.statusError || "",
      sharedDeps: item.sharedDeps,
      removable: item.removable,
      busy: isRoomBusy(item.id),
      busyBy: getBusyBy(item.id),
    })),
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
    const rooms = await listRooms();
    const roomWindows = [];
    for (const room of rooms) {
      roomWindows.push({
        id: room.id,
        title: room.cdpTitle,
        status: room.status,
        open: room.status === "ready" ? await cursorWindowOpen(room.cdpTitle) : false,
      });
    }
    return c.json(
      {
        ok: cdp.ok,
        backend: "cdp",
        cdp,
        rooms: roomWindows,
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
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;

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
      roomId: room.id,
      clientId: user.clientId,
      displayName: user.displayName,
      send,
    });

    const snapshot = await buildSnapshot(room.id);
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

app.get("/api/rooms/events", requireAuth, async (c) => {
  return streamSSE(c, async (stream) => {
    let closed = false;
    const unsubscribe = subscribeStatus((event) => {
      if (closed) return;
      void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
    });
    const heartbeat = setInterval(() => {
      void stream.writeSSE({ event: "ping", data: JSON.stringify({ t: Date.now() }) });
    }, 15_000);
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
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;
  return c.json({ artifacts: await listArtifacts(room.id) });
});

app.get("/api/history", requireAuth, async (c) => {
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;
  const before = (c.req.query("before") || "").trim();
  const rawLimit = Number(c.req.query("limit"));
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : HISTORY_PAGE;
  const page = await loadHistoryPage(room.id, {
    limit,
    beforeId: before || undefined,
  });
  if ("error" in page) {
    return apiError(c, "history_before_invalid", 400);
  }
  return c.json({
    messages: page.messages,
    hasMore: page.hasMore,
  });
});

app.post("/api/history/clear", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;
  if (isRoomBusy(room.id)) {
    const by = getBusyBy(room.id);
    return by
      ? apiError(c, "agent_busy_by", 409, { name: by.displayName })
      : apiError(c, "agent_busy", 409);
  }

  try {
    await clearHistory(room.id);
    await clearArtifacts(room.id);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : tApi(localeFromContext(c), "history_clear_failed") },
      500,
    );
  }

  broadcast(room.id, {
    type: "history_cleared",
    data: { clearedBy: user.displayName, at: Date.now() },
    at: Date.now(),
  });
  console.log(`[history] cleared by=${user.displayName}`);
  return c.json({ ok: true });
});

app.post("/api/history/delete", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;
  let id = "";
  try {
    const body = await c.req.json<{ id?: string }>();
    id = typeof body.id === "string" ? body.id.trim() : "";
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  if (!id) return apiError(c, "history_id_required", 400);
  if (getStreamingMessageId(room.id) === id) {
    return apiError(c, "history_message_in_progress", 409);
  }

  try {
    const result = await deleteHistoryMessage(room.id, id);
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

  broadcast(room.id, {
    type: "message_deleted",
    data: { id, deletedBy: user.displayName },
    at: Date.now(),
  });
  console.log(`[history] deleted id=${id} by=${user.displayName}`);
  return c.json({ ok: true });
});

app.post("/api/draft", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;
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
  broadcast(room.id, {
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
  const room = await readyRoom(c, c.req.query("room") || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;

  try {
    const resolved = await resolveSafeTmpPath(room.id, pathParam);
    const known = await listArtifacts(room.id);
    const allowed = known.some(
      (item) => item.path === resolved.absolutePath || resolved.absolutePath.startsWith(`${item.path}/`),
    );
    if (!allowed) return apiError(c, "download_failed", 404);
    let filePath = resolved.absolutePath;
    let kind = resolved.kind;
    let downloadName = downloadFileName(filePath, kind);

    if (kind === "dir") {
      filePath = await zipDirectoryToTemp(room.id, filePath);
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
  const contentType = c.req.header("content-type") || "";
  let text = "";
  let roomId = (c.req.query("room") || "").trim();
  const images: ChatImage[] = [];
  const attachments: ChatAttachmentMeta[] = [];
  const files: File[] = [];

  try {
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.parseBody({ all: true });
      text = typeof body.text === "string" ? body.text : "";
      if (typeof body.room === "string" && body.room.trim()) roomId = body.room.trim();
      const filesRaw = body.files;
      if (filesRaw instanceof File) files.push(filesRaw);
      else if (Array.isArray(filesRaw)) {
        for (const item of filesRaw) {
          if (item instanceof File) files.push(item);
        }
      }
    } else {
      const body = await c.req.json<{
        text?: string;
        room?: string;
        images?: ChatImage[];
        attachments?: ChatAttachmentMeta[];
      }>();
      text = body.text ?? "";
      if (typeof body.room === "string" && body.room.trim()) roomId = body.room.trim();
      if (Array.isArray(body.images)) images.push(...body.images);
      if (Array.isArray(body.attachments)) attachments.push(...body.attachments);
    }
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : tApi(localeFromContext(c), "invalid_payload") }, 400);
  }

  const room = await readyRoom(c, roomId || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;

  if (isRoomBusy(room.id)) {
    const by = getBusyBy(room.id);
    return c.json(
      {
        error: by
          ? tApi(localeFromContext(c), "agent_busy_by", { name: by.displayName })
          : tApi(localeFromContext(c), "agent_busy"),
      },
      409,
    );
  }

  setRoomBusy(room.id, { clientId: user.clientId, displayName: user.displayName });
  console.log(
    `[chat] turn start room=${room.id} by=${user.displayName} clientId=${user.clientId.slice(0, 8)}…`,
  );

  try {
    for (const file of files) {
      const stored = await storeUploadedFile(file, join(room.folder, ".cursor-web-bridge-uploads"));
      attachments.push(stored.meta);
      if (stored.image) images.push(stored.image);
    }
  } catch (err) {
    setRoomBusy(room.id, null);
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
    setRoomBusy(room.id, null);
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
  await appendHistory(room.id, userMessage);
  broadcast(room.id, { type: "user_message", data: userMessage, at: Date.now() });

  const assistantMessageId = newMessageId();
  setStreamingMessageId(room.id, assistantMessageId);

  broadcast(room.id, {
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

  const locale = localeFromContext(c);
  const startedBy = user.displayName;
  broadcast(room.id, {
    type: "status",
    data: { message: `Turno iniciado por ${startedBy}`, messageId: assistantMessageId },
    at: Date.now(),
  });

  // Answer now so a long turn is not cut by the proxy's idle response limit.
  // Busy stays set until the background turn finishes.
  void (async () => {
    let assistantText = "";
    const seenPaths = new Set<string>();

    const registerFromText = async (chunk: string) => {
      const named = await filterExistingTmpPaths(extractTmpBasenameCandidates(chunk));
      const paths = [...new Set([...extractTmpPaths(chunk), ...named])];
      const fresh = paths.filter((p) => !seenPaths.has(p));
      for (const p of fresh) seenPaths.add(p);
      if (fresh.length === 0) return;
      const created = await registerArtifacts(room.id, fresh);
      if (created.length) publishArtifacts(room.id, created, { messageId: assistantMessageId });
    };

    try {
      touchRoomActivity(room.id);
      if (!(await cursorWindowOpen(room.cdpTitle))) {
        broadcast(room.id, {
          type: "status",
          data: {
            message: tApi(locale, "opening_window"),
            code: "opening_window",
            messageId: assistantMessageId,
          },
          at: Date.now(),
        });
      }
      await ensureRoomWindow(room);
      const result = await runChatTurn({
        text,
        images,
        attachments,
        target: room.cdpTitle,
        reopenWindow: () => ensureRoomWindow(room),
        handlers: {
          onText: (chunk) => {
            assistantText += chunk;
            broadcast(room.id, {
              type: "assistant_token",
              data: {
                messageId: assistantMessageId,
                text: chunk,
                startedAt: turnStartedAt,
                startedBy,
                running: true,
              },
              at: Date.now(),
            });
            void registerFromText(chunk);
          },
          onReplace: (fullText) => {
            assistantText = fullText;
            broadcast(room.id, {
              type: "assistant_replace",
              data: {
                messageId: assistantMessageId,
                text: fullText,
                startedAt: turnStartedAt,
                startedBy,
                running: true,
              },
              at: Date.now(),
            });
            void registerFromText(fullText);
          },
          onStatus: (message) => {
            broadcast(room.id, {
              type: "status",
              data: { message, messageId: assistantMessageId },
              at: Date.now(),
            });
          },
          onActivity: (lines) => {
            broadcast(room.id, {
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
          onDecision: (decision) => {
            if (decision) {
              setPendingDecision(room.id, decision);
            } else if (getPendingDecision(room.id)) {
              clearPendingDecision(room.id);
            }
          },
        },
      });

      await registerFromText(assistantText);

      const completedAt = Date.now();
      const artifactPaths = [...seenPaths];
      const assistantMessage = {
        id: assistantMessageId,
        role: "assistant" as const,
        text: assistantText || tApi(locale, "finished", { status: result.status || "ok" }),
        createdAt: turnStartedAt,
        completedAt,
        durationMs: completedAt - turnStartedAt,
        startedBy,
        status: result.status || "finished",
        artifactPaths,
      };
      await appendHistory(room.id, assistantMessage);
      broadcast(room.id, {
        type: "assistant_done",
        data: {
          message: assistantMessage,
          result,
        },
        at: Date.now(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : tApi(locale, "unknown_error");
      const completedAt = Date.now();
      if (assistantText.trim() || seenPaths.size > 0) {
        const partial = {
          id: assistantMessageId,
          role: "assistant" as const,
          text: assistantText || tApi(locale, "error_wrap", { message }),
          createdAt: turnStartedAt,
          completedAt,
          durationMs: completedAt - turnStartedAt,
          startedBy,
          status: "error",
          artifactPaths: [...seenPaths],
        };
        await appendHistory(room.id, partial);
        broadcast(room.id, {
          type: "assistant_done",
          data: { message: partial, result: { status: "error" } },
          at: Date.now(),
        });
      }
      broadcast(room.id, {
        type: "room_error",
        data: { error: message, messageId: assistantMessageId },
        at: Date.now(),
      });
      console.error(`[chat] turn failed messageId=${assistantMessageId}`, message);
    } finally {
      touchRoomActivity(room.id);
      setStreamingMessageId(room.id, null);
      if (!getPendingDecision(room.id)) {
        setRoomBusy(room.id, null);
      }
      console.log(
        `[chat] turn end room=${room.id} messageId=${assistantMessageId} by=${startedBy} pendingDecision=${Boolean(getPendingDecision(room.id))}`,
      );
    }
  })();

  return c.json({ ok: true, messageId: assistantMessageId });
});

app.post("/api/decision", requireAuth, async (c) => {
  const user = getSessionUser(c)!;
  if (config.backend !== "cdp") {
    return apiError(c, "decision_sdk_unsupported", 409);
  }

  let optionId = "";
  let roomId = (c.req.query("room") || "").trim();
  try {
    const body = await c.req.json<{ optionId?: string; room?: string }>();
    optionId = typeof body.optionId === "string" ? body.optionId.trim() : "";
    if (typeof body.room === "string" && body.room.trim()) roomId = body.room.trim();
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  const room = await readyRoom(c, roomId || GENERAL_ROOM_ID);
  if (isResponse(room)) return room;
  if (!optionId) return apiError(c, "unknown_decision_option", 400);

  const claim = claimDecision(room.id, optionId);
  if (!claim.ok) {
    if (claim.reason === "none") return apiError(c, "no_pending_decision", 409);
    if (claim.reason === "claimed") return apiError(c, "decision_already", 409);
    return apiError(c, "unknown_decision_option", 400);
  }

  try {
    const result = await clickDecision(optionId, room.cdpTitle);
    if (!result.ok) {
      if (result.error === "no-card") {
        clearPendingDecision(room.id);
        return apiError(c, "no_pending_decision", 409);
      }
      releaseDecisionClaim(room.id);
      return apiError(c, "decision_click_failed", 500);
    }
    clearPendingDecision(room.id, { by: user.displayName, optionId });
    console.log(`[decision] room=${room.id} option=${optionId} by=${user.displayName}`);
    return c.json({ ok: true, optionId, label: result.label || "" });
  } catch (err) {
    releaseDecisionClaim(room.id);
    return c.json(
      {
        error:
          err instanceof Error ? err.message : tApi(localeFromContext(c), "decision_click_failed"),
      },
      500,
    );
  }
});

app.post("/api/upload", requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody({ all: true });
    const room = await readyRoom(
      c,
      (typeof body.room === "string" ? body.room : "") || c.req.query("room") || GENERAL_ROOM_ID,
    );
    if (isResponse(room)) return room;
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
      stored.push(await storeUploadedFile(file, join(room.folder, ".cursor-web-bridge-uploads")));
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

app.get("/api/admin/capacity", requireAdmin, async (c) => {
  return c.json({
    own: await checkCapacity(false),
    shared: await checkCapacity(true),
  });
});

app.get("/api/admin/users", requireAdmin, async (c) => {
  return c.json({ users: await listUsers() });
});

app.post("/api/admin/users", requireAdmin, async (c) => {
  let body: { username?: string; displayName?: string; password?: string; role?: string };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  try {
    const created = await createUser({
      username: body.username || "",
      displayName: body.displayName || "",
      password: body.password || "",
      role: body.role === "admin" ? "admin" : "member",
    });
    return c.json({ ok: true, user: created });
  } catch (err) {
    return apiError(c, err instanceof Error ? err.message : "user_invalid", 400);
  }
});

app.delete("/api/admin/users/:id", requireAdmin, async (c) => {
  const actor = getSessionUser(c)!;
  try {
    await deleteUser(c.req.param("id"), actor.userId);
    return c.json({ ok: true });
  } catch (err) {
    return apiError(c, err instanceof Error ? err.message : "user_missing", 400);
  }
});

app.post("/api/admin/rooms", requireAdmin, async (c) => {
  const actor = getSessionUser(c)!;
  let body: { title?: string; sharedDeps?: boolean; force?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return apiError(c, "invalid_json", 400);
  }
  try {
    const created = await createWorkspace({
      title: body.title || "",
      createdBy: actor.userId,
      sharedDeps: Boolean(body.sharedDeps),
      force: Boolean(body.force),
    });
    return c.json({ ok: true, room: created.room, capacity: created.capacity }, 202);
  } catch (err) {
    const packed = capacityBody(err);
    if (packed) {
      return c.json(
        { error: tApi(localeFromContext(c), packed.error), capacity: packed.capacity },
        409,
      );
    }
    return apiError(c, err instanceof Error ? err.message : "workspace_failed", 400);
  }
});

app.delete("/api/admin/rooms/:id", requireAdmin, async (c) => {
  let body: { keepFolder?: boolean; force?: boolean } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  try {
    await deleteWorkspace({
      id: c.req.param("id"),
      keepFolder: Boolean(body.keepFolder),
      force: Boolean(body.force),
    });
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof Error && err.message === "workspace_dirty") {
      return c.json(
        {
          error: tApi(localeFromContext(c), "workspace_dirty"),
          detail: (err as Error & { detail?: string }).detail || "",
        },
        409,
      );
    }
    return apiError(c, err instanceof Error ? err.message : "workspace_failed", 400);
  }
});

const publicRelative = relative(process.cwd(), config.publicDir) || "public";
app.use(
  "/*",
  serveStatic({
    root: publicRelative,
  }),
);

async function main(): Promise<void> {
  await initStore();
  await prepareWorkspaceBase();
  void ensureAllWindows();
  startIdleWindowCloser();

  console.log(`[bridge] backend -> ${config.backend}`);
  if (config.backend === "cdp") {
    console.log(`[bridge] cdp -> ${config.cursorCdpUrl}`);
  } else {
    console.log(`[bridge] cwd agent -> ${config.cursorCwd}`);
  }
  console.log(`[bridge] starting on http://${config.bindHost}:${config.port}`);

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: config.bindHost,
    },
    () => {
      console.log(`[bridge] listening on http://${config.bindHost}:${config.port}`);
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
}

void main();

