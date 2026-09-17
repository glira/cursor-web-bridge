import { createRoomRtc } from "./rtc.js";
import { t, applyI18n } from "./i18n.js?v=6";

applyI18n();

const messagesEl = document.getElementById("messages");
const form = document.getElementById("composer");
const textEl = document.getElementById("text");
const filesEl = document.getElementById("files");
const chipsEl = document.getElementById("file-chips");
const sendBtn = document.getElementById("send");
const logoutBtn = document.getElementById("logout");
const clearHistoryBtn = document.getElementById("clear-history");
const clearHistoryDialog = document.getElementById("clear-history-dialog");
const clearHistoryCancel = document.getElementById("clear-history-cancel");
const clearHistoryConfirm = document.getElementById("clear-history-confirm");
const clearHistoryError = document.getElementById("clear-history-error");
const deleteMessageDialog = document.getElementById("delete-message-dialog");
const deleteMessageCancel = document.getElementById("delete-message-cancel");
const deleteMessageConfirm = document.getElementById("delete-message-confirm");
const deleteMessageError = document.getElementById("delete-message-error");
const meLabel = document.getElementById("me-label");
const presenceLabel = document.getElementById("presence-label");
const busyLabel = document.getElementById("busy-label");
const typingLabel = document.getElementById("typing-label");
const activityPanel = document.getElementById("agent-activity");
const activityBody = document.getElementById("agent-activity-body");
const turnClock = document.getElementById("turn-clock");
const decisionCard = document.getElementById("decision-card");
const decisionTitle = document.getElementById("decision-title");
const decisionPrompt = document.getElementById("decision-prompt");
const decisionOptions = document.getElementById("decision-options");
const decisionStatus = document.getElementById("decision-status");
const historyLoader = document.getElementById("history-loader");
const livePanel = document.querySelector(".live-panel");
const liveJoinBtn = document.getElementById("live-join");
const liveLeaveBtn = document.getElementById("live-leave");
const liveMicBtn = document.getElementById("live-mic");
const liveCamBtn = document.getElementById("live-cam");
const liveTiles = document.getElementById("live-tiles");
const liveStatus = document.getElementById("live-status");
const liveRoster = document.getElementById("live-roster");

/** @type {File[]} */
let pendingFiles = [];
/** @type {string | null} */
let myClientId = null;
/** @type {string | null} */
let myDisplayName = null;
let roomBusy = false;
/** @type {Map<string, HTMLElement>} */
const bubbleById = new Map();
/** @type {Map<string, any>} */
const messageMeta = new Map();
/** @type {Map<string, Set<string>>} */
const downloadsByMessage = new Map();
/** @type {string | null} */
let pendingDeleteId = null;

let localTyping = false;
let draftTimer = null;
let typingHideTimer = null;
let applyingRemoteDraft = false;
let pinToBottom = true;
let turnStartedAt = null;
let turnClockTimer = null;
let liveElapsedTimer = null;
/** @type {{ kind?: string, prompt?: string, options?: { id: string, label: string }[] } | null} */
let currentDecision = null;
let decisionSubmitting = false;
let decisionHideTimer = null;
let historyHasMore = false;
/** @type {string | null} */
let oldestLoadedId = null;
let loadingOlder = false;

const PIN_THRESHOLD_PX = 80;
const HISTORY_TOP_PX = 80;

function updateLiveControls() {
  const on = rtc.isInLive();
  if (livePanel) livePanel.classList.toggle("live-panel--on", on);
  liveJoinBtn.hidden = on;
  liveLeaveBtn.hidden = !on;
  liveMicBtn.disabled = !on;
  liveCamBtn.disabled = !on;
  liveMicBtn.textContent = rtc.getMicEnabled() ? t("live.micOn") : t("live.micOff");
  liveCamBtn.textContent = rtc.getCamEnabled() ? t("live.camOn") : t("live.camOff");
}

function updateLiveRoster(peers, inLive) {
  const others = (peers || []).filter((p) => p.clientId !== myClientId);
  if (!others.length) {
    liveRoster.textContent = inLive ? t("live.onlyYou") : t("live.nobody");
    return;
  }
  liveRoster.textContent = t("live.with", {
    names: others.map((p) => p.displayName).join(", "),
  });
}

const rtc = createRoomRtc({
  getClientId: () => myClientId,
  getDisplayName: () => myDisplayName,
  tilesEl: liveTiles,
  statusEl: liveStatus,
  onPeersChanged: (peers, inLive) => {
    updateLiveRoster(peers, inLive);
    updateLiveControls();
  },
});

liveJoinBtn.addEventListener("click", async () => {
  try {
    liveJoinBtn.disabled = true;
    await rtc.join();
  } catch (err) {
    appendSystem(err instanceof Error ? err.message : t("live.joinFailed"));
    liveStatus.textContent = t("live.failed");
  } finally {
    liveJoinBtn.disabled = false;
    updateLiveControls();
  }
});

liveLeaveBtn.addEventListener("click", async () => {
  await rtc.leave();
  updateLiveControls();
});

liveMicBtn.addEventListener("click", () => {
  rtc.setMicEnabled(!rtc.getMicEnabled());
  updateLiveControls();
});

liveCamBtn.addEventListener("click", () => {
  rtc.setCamEnabled(!rtc.getCamEnabled());
  updateLiveControls();
});

function formatTime(ts) {
  if (!ts || !Number.isFinite(ts)) return "";
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function basenamePath(p) {
  const parts = String(p || "").split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function isPinnedToBottom() {
  const el = messagesEl;
  return el.scrollHeight - el.scrollTop - el.clientHeight < PIN_THRESHOLD_PX;
}

function scrollToBottom(force = false) {
  if (force || pinToBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    pinToBottom = true;
  }
}

function scrollToBottomIfPinned() {
  if (pinToBottom || isPinnedToBottom()) {
    pinToBottom = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function firstHistoryId(messages) {
  for (const msg of messages || []) {
    if (msg?.id && msg.role !== "system") return msg.id;
  }
  return messages?.[0]?.id || null;
}

function syncHistoryLoader() {
  if (!historyLoader) return;
  if (historyLoader.parentNode !== messagesEl) {
    messagesEl.insertBefore(historyLoader, messagesEl.firstChild);
  }
  if (loadingOlder) {
    historyLoader.hidden = false;
    historyLoader.textContent = t("history.loading");
  } else if (historyHasMore) {
    historyLoader.hidden = false;
    historyLoader.textContent = t("history.olderHint");
  } else {
    historyLoader.hidden = true;
    historyLoader.textContent = "";
  }
}

async function loadOlderHistory() {
  if (!historyHasMore || loadingOlder || !oldestLoadedId) return;
  loadingOlder = true;
  syncHistoryLoader();
  const prevHeight = messagesEl.scrollHeight;
  const prevTop = messagesEl.scrollTop;
  try {
    const res = await fetch(
      `/api/history?before=${encodeURIComponent(oldestLoadedId)}&limit=40`,
    );
    if (res.status === 401) {
      location.href = "/";
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || t("history.loading"));
    const msgs = Array.isArray(data.messages) ? data.messages : [];
    if (msgs.length === 0) {
      historyHasMore = false;
    } else {
      historyHasMore = Boolean(data.hasMore);
      oldestLoadedId = firstHistoryId(msgs) || oldestLoadedId;
    }
    const fragment = document.createDocumentFragment();
    for (const msg of msgs) {
      if (msg.role === "system") {
        const el = document.createElement("div");
        el.className = "bubble system";
        el.textContent = msg.text;
        fragment.appendChild(el);
      } else {
        ensureBubble(msg, { parent: fragment, skipScroll: true });
      }
    }
    const anchor = historyLoader?.nextSibling || messagesEl.firstChild;
    messagesEl.insertBefore(fragment, anchor);
  } catch (err) {
    console.warn("[ui] older history", err);
  } finally {
    const delta = messagesEl.scrollHeight - prevHeight;
    messagesEl.scrollTop = prevTop + delta;
    loadingOlder = false;
    syncHistoryLoader();
    if (historyHasMore && messagesEl.scrollHeight <= messagesEl.clientHeight + 8) {
      void loadOlderHistory();
    }
  }
}

messagesEl.addEventListener("scroll", () => {
  pinToBottom = isPinnedToBottom();
  if (!pinToBottom && messagesEl.scrollTop < HISTORY_TOP_PX) {
    void loadOlderHistory();
  }
});

function buildMetaText(meta) {
  if (!meta) return "";
  if (meta.role === "user") {
    const name = meta.displayName || t("meta.user");
    const time = formatTime(meta.createdAt);
    return time ? `${name} · ${time}` : name;
  }
  if (meta.role === "assistant") {
    const parts = [t("meta.agent")];
    if (meta.startedBy) parts.push(t("meta.by", { name: meta.startedBy }));
    if (meta.running) {
      const start = formatTime(meta.createdAt || meta.startedAt);
      const elapsed = formatDuration(
        Date.now() - (meta.createdAt || meta.startedAt || Date.now()),
      );
      if (start) parts.push(t("meta.started", { time: start }));
      parts.push(meta.awaitingFinal ? t("meta.awaiting") : t("meta.running"));
      if (elapsed) parts.push(elapsed);
      return parts.join(" · ");
    }
    const start = formatTime(meta.createdAt);
    const end = formatTime(meta.completedAt);
    if (start && end) parts.push(`${start} → ${end}`);
    else if (start) parts.push(start);
    if (meta.durationMs != null) parts.push(formatDuration(meta.durationMs));
    if (meta.status) {
      if (meta.status === "timeout") {
        parts.push(t("meta.timeout"));
      } else {
        parts.push(meta.status);
      }
    }
    return parts.join(" · ");
  }
  return "";
}

function updateBubbleMeta(messageId) {
  const el = bubbleById.get(messageId);
  if (!el) return;
  let metaEl = el.querySelector(".bubble-meta");
  if (!metaEl) {
    metaEl = document.createElement("div");
    metaEl.className = "bubble-meta";
    el.appendChild(metaEl);
  }
  metaEl.textContent = buildMetaText(messageMeta.get(messageId));
  syncDeleteControl(messageId);
}

function ensureDownloadsContainer(messageId) {
  const el = bubbleById.get(messageId);
  if (!el) return null;
  let box = el.querySelector(".bubble-downloads");
  if (!box) {
    box = document.createElement("div");
    box.className = "bubble-downloads";
    const meta = el.querySelector(".bubble-meta");
    if (meta) el.insertBefore(box, meta);
    else el.appendChild(box);
  }
  return box;
}

function addDownloadButton(messageId, path, kind = "file") {
  if (!path) return;
  if (!downloadsByMessage.has(messageId)) downloadsByMessage.set(messageId, new Set());
  const set = downloadsByMessage.get(messageId);
  if (set.has(path)) return;
  set.add(path);

  const bubble = ensureBubble({
    id: messageId,
    role: "assistant",
    text: messageMeta.get(messageId)?.text || "",
    createdAt: messageMeta.get(messageId)?.createdAt,
  });
  const box = ensureDownloadsContainer(messageId);
  if (!box) return;

  const a = document.createElement("a");
  a.className = "artifact-dl";
  a.href = `/api/artifacts/download?path=${encodeURIComponent(path)}`;
  a.setAttribute("download", "");
  const label = document.createElement("span");
  label.textContent =
    kind === "dir"
      ? t("dl.dir", { name: basenamePath(path) })
      : t("dl.file", { name: basenamePath(path) });
  a.appendChild(label);
  a.title = path;
  box.appendChild(a);
  scrollToBottomIfPinned();
}

function appendSystem(text) {
  const el = document.createElement("div");
  el.className = "bubble system";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottomIfPinned();
  return el;
}

function ensureBubble(message, opts = {}) {
  let el = bubbleById.get(message.id);
  if (el) {
    if (message.text != null) {
      const body = el.querySelector(".bubble-body");
      if (body && message.replaceText) body.textContent = message.text;
    }
    syncDeleteControl(message.id);
    return el;
  }

  el = document.createElement("div");
  el.className = `bubble ${message.role}`;
  el.dataset.messageId = message.id;

  if (message.role === "user" || message.role === "assistant") {
    const head = document.createElement("div");
    head.className = "bubble-head";
    const author = document.createElement("div");
    author.className = "bubble-author";
    author.textContent =
      message.role === "assistant" ? t("meta.agent") : message.displayName || t("meta.user");
    const del = document.createElement("button");
    del.type = "button";
    del.className = "ghost bubble-delete";
    del.textContent = t("delete.button");
    del.hidden = Boolean(message.running);
    del.addEventListener("click", (e) => {
      e.preventDefault();
      openDeleteMessageDialog(message.id);
    });
    head.appendChild(author);
    head.appendChild(del);
    el.appendChild(head);
  }

  const body = document.createElement("div");
  body.className = "bubble-body";
  body.textContent = message.text || "";
  el.appendChild(body);

  const metaEl = document.createElement("div");
  metaEl.className = "bubble-meta";
  el.appendChild(metaEl);

  const parent = opts.parent || messagesEl;
  parent.appendChild(el);
  bubbleById.set(message.id, el);

  messageMeta.set(message.id, {
    role: message.role,
    displayName: message.displayName,
    createdAt: message.createdAt,
    completedAt: message.completedAt,
    durationMs: message.durationMs,
    startedBy: message.startedBy,
    status: message.status,
    running: Boolean(message.running),
    text: message.text || "",
  });
  updateBubbleMeta(message.id);

  if (Array.isArray(message.artifactPaths)) {
    for (const p of message.artifactPaths) addDownloadButton(message.id, p);
  }

  if (!opts.skipScroll) scrollToBottomIfPinned();
  return el;
}

function setBubbleText(messageId, text) {
  const el = bubbleById.get(messageId);
  if (!el) {
    ensureBubble({ id: messageId, role: "assistant", text });
    return;
  }
  const body = el.querySelector(".bubble-body");
  if (body) body.textContent = text;
  const meta = messageMeta.get(messageId) || { role: "assistant" };
  meta.text = text;
  messageMeta.set(messageId, meta);
  scrollToBottomIfPinned();
}

function appendToken(messageId, chunk, extra = {}) {
  let el = bubbleById.get(messageId);
  if (!el) {
    el = ensureBubble({
      id: messageId,
      role: "assistant",
      text: "",
      createdAt: extra.startedAt || Date.now(),
      startedBy: extra.startedBy,
      running: true,
    });
  }
  if (chunk) {
    const body = el.querySelector(".bubble-body");
    if (body) body.textContent += chunk;
  }
  const meta = messageMeta.get(messageId) || { role: "assistant" };
  meta.running = extra.running !== false;
  if (extra.startedAt) meta.createdAt = extra.startedAt;
  if (extra.startedBy) meta.startedBy = extra.startedBy;
  messageMeta.set(messageId, meta);
  updateBubbleMeta(messageId);
  scrollToBottomIfPinned();
}

function renderChips() {
  chipsEl.innerHTML = "";
  pendingFiles.forEach((file, index) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = file.name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      pendingFiles.splice(index, 1);
      renderChips();
    });
    chip.appendChild(remove);
    chipsEl.appendChild(chip);
  });
}

function stopTurnClock() {
  if (turnClockTimer) {
    clearInterval(turnClockTimer);
    turnClockTimer = null;
  }
  if (liveElapsedTimer) {
    clearInterval(liveElapsedTimer);
    liveElapsedTimer = null;
  }
  turnStartedAt = null;
  turnClock.textContent = "";
}

function startTurnClock(startedAt) {
  turnStartedAt = startedAt || Date.now();
  const tick = () => {
    if (!turnStartedAt) return;
    turnClock.textContent = t("ui.turn", { duration: formatDuration(Date.now() - turnStartedAt) });
    for (const [id, meta] of messageMeta) {
      if (meta.running) updateBubbleMeta(id);
    }
  };
  tick();
  if (turnClockTimer) clearInterval(turnClockTimer);
  turnClockTimer = setInterval(tick, 1000);
}

function setBusy(busy, by, reason = "") {
  roomBusy = Boolean(busy);
  sendBtn.disabled = roomBusy;
  clearHistoryBtn.disabled = roomBusy;
  console.debug(
    `[ui] setBusy busy=${roomBusy} by=${by?.displayName ?? "-"} reason=${reason || "-"}`,
  );
  if (roomBusy && by?.displayName) {
    busyLabel.hidden = false;
    busyLabel.textContent = t("ui.replyingBy", { name: by.displayName });
  } else if (roomBusy) {
    busyLabel.hidden = false;
    busyLabel.textContent = t("ui.replying");
  } else {
    busyLabel.hidden = true;
    busyLabel.textContent = "";
  }
  if (!roomBusy) {
    renderActivity([]);
    stopTurnClock();
  }
}

function renderPresence(members) {
  if (!Array.isArray(members) || members.length === 0) {
    presenceLabel.textContent = t("ui.offline");
    return;
  }
  presenceLabel.textContent = t("ui.online", {
    names: members.map((m) => m.displayName).join(", "),
  });
}

function hideDecisionCard() {
  currentDecision = null;
  decisionSubmitting = false;
  if (decisionHideTimer) {
    clearTimeout(decisionHideTimer);
    decisionHideTimer = null;
  }
  decisionCard.hidden = true;
  decisionTitle.textContent = "";
  decisionPrompt.textContent = "";
  decisionPrompt.hidden = true;
  decisionOptions.replaceChildren();
  decisionStatus.hidden = true;
  decisionStatus.textContent = "";
}

function renderDecision(decision) {
  if (decisionHideTimer) {
    clearTimeout(decisionHideTimer);
    decisionHideTimer = null;
  }
  if (!decision || !Array.isArray(decision.options) || decision.options.length === 0) {
    hideDecisionCard();
    return;
  }
  currentDecision = decision;
  decisionSubmitting = false;
  decisionCard.hidden = false;
  decisionTitle.textContent =
    decision.kind === "question" ? t("decision.questionTitle") : t("decision.approvalTitle");
  const prompt = typeof decision.prompt === "string" ? decision.prompt.trim() : "";
  decisionPrompt.textContent = prompt;
  decisionPrompt.hidden = !prompt;
  decisionStatus.hidden = false;
  decisionStatus.textContent = t("decision.waiting");
  decisionOptions.replaceChildren();
  for (const option of decision.options) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = option.label;
    btn.dataset.optionId = option.id;
    btn.addEventListener("click", () => {
      void submitDecision(option.id);
    });
    decisionOptions.appendChild(btn);
  }
}

function renderDecisionResolved(data) {
  const by = typeof data?.by === "string" ? data.by : "";
  const optionId = typeof data?.optionId === "string" ? data.optionId : "";
  const label =
    currentDecision?.options?.find((option) => option.id === optionId)?.label || optionId;
  for (const btn of decisionOptions.querySelectorAll("button")) {
    btn.disabled = true;
  }
  decisionSubmitting = false;
  if (!by || data?.dismissed) {
    decisionStatus.hidden = false;
    decisionStatus.textContent = t("decision.dismissed");
  } else {
    decisionStatus.hidden = false;
    decisionStatus.textContent = t("decision.resolvedBy", { name: by, choice: label });
  }
  if (decisionHideTimer) clearTimeout(decisionHideTimer);
  decisionHideTimer = setTimeout(() => {
    hideDecisionCard();
  }, 4000);
}

async function submitDecision(optionId) {
  if (!currentDecision || decisionSubmitting) return;
  decisionSubmitting = true;
  decisionStatus.hidden = true;
  decisionStatus.textContent = "";
  for (const btn of decisionOptions.querySelectorAll("button")) {
    btn.disabled = true;
  }
  try {
    const res = await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ optionId }),
    });
    if (res.status === 401) {
      location.href = "/";
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || t("decision.failed"));
    }
  } catch (err) {
    decisionSubmitting = false;
    decisionStatus.hidden = false;
    decisionStatus.textContent = err instanceof Error ? err.message : t("decision.failed");
    for (const btn of decisionOptions.querySelectorAll("button")) {
      btn.disabled = false;
    }
  }
}

function renderActivity(lines, elapsedMs) {
  const list = Array.isArray(lines) ? lines.filter(Boolean) : [];
  const awaitingFinal = list.some((l) =>
    /aguardando resposta final|waiting for (the )?final reply/i.test(l),
  );
  for (const [id, meta] of messageMeta) {
    if (meta.role !== "assistant" || !meta.running) continue;
    if (Boolean(meta.awaitingFinal) === awaitingFinal) continue;
    meta.awaitingFinal = awaitingFinal;
    messageMeta.set(id, meta);
    updateBubbleMeta(id);
  }
  if (list.length === 0) {
    activityPanel.hidden = true;
    activityBody.textContent = "";
    return;
  }
  activityPanel.hidden = false;
  activityBody.textContent = list.join("\n");
  if (elapsedMs != null && turnStartedAt == null) {
    turnClock.textContent = t("ui.turn", { duration: formatDuration(elapsedMs) });
  }
}

function showTyping(displayName) {
  if (!displayName) {
    typingLabel.hidden = true;
    typingLabel.textContent = "";
    return;
  }
  typingLabel.hidden = false;
  typingLabel.textContent = t("ui.typing", { name: displayName });
  if (typingHideTimer) clearTimeout(typingHideTimer);
  typingHideTimer = setTimeout(() => {
    typingLabel.hidden = true;
    typingLabel.textContent = "";
  }, 2500);
}

function applySnapshot(snapshot) {
  messagesEl.innerHTML = "";
  bubbleById.clear();
  messageMeta.clear();
  downloadsByMessage.clear();
  if (historyLoader) messagesEl.appendChild(historyLoader);

  const page = snapshot.messages || [];
  historyHasMore = Boolean(snapshot.historyHasMore);
  oldestLoadedId = firstHistoryId(page);
  loadingOlder = false;
  syncHistoryLoader();

  for (const msg of page) {
    if (msg.role === "system") appendSystem(msg.text);
    else ensureBubble(msg, { skipScroll: true });
  }

  for (const msg of page) {
    if (msg.role !== "assistant") continue;
    for (const p of msg.artifactPaths || []) addDownloadButton(msg.id, p);
  }

  renderPresence(snapshot.members || []);
  setBusy(snapshot.busy, snapshot.busyBy, "snapshot");
  renderActivity([]);
  renderDecision(snapshot.pendingDecision || null);
  rtc.handleEvent("snapshot", snapshot);

  if (snapshot.busy && snapshot.streamingMessageId) {
    ensureBubble({
      id: snapshot.streamingMessageId,
      role: "assistant",
      text: "",
      running: true,
      createdAt: Date.now(),
      startedBy: snapshot.busyBy?.displayName,
    }, { skipScroll: true });
    startTurnClock(Date.now());
  }

  if (page.length === 0) {
    appendSystem(t("ui.emptyRoom"));
  }

  syncHistoryLoader();
  scrollToBottom(true);
}

async function publishDraft(text) {
  try {
    await fetch("/api/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn("[ui] draft publish failed", err);
  }
}

function scheduleDraftPublish() {
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    void publishDraft(textEl.value);
  }, 120);
}

function connectEvents() {
  const es = new EventSource("/api/events");

  es.addEventListener("snapshot", (ev) => {
    try {
      applySnapshot(JSON.parse(ev.data));
    } catch (err) {
      console.error(err);
    }
  });

  for (const name of ["rtc_peer_joined", "rtc_peer_left", "rtc_peers", "rtc_signal"]) {
    es.addEventListener(name, (ev) => {
      try {
        rtc.handleEvent(name, JSON.parse(ev.data));
        updateLiveControls();
      } catch (err) {
        console.warn(`[rtc] ${name}`, err);
      }
    });
  }

  es.addEventListener("presence", (ev) => {
    try {
      renderPresence(JSON.parse(ev.data).members || []);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("busy", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      setBusy(data.busy, data.by, "sse-busy");
      if (data.busy) startTurnClock(Date.now());
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("user_message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      pinToBottom = true;
      ensureBubble(msg);
      scrollToBottom(true);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("assistant_token", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.startedAt && !turnStartedAt) startTurnClock(data.startedAt);
      appendToken(data.messageId, data.text || "", data);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("assistant_replace", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      setBubbleText(data.messageId, data.text || "");
      const meta = messageMeta.get(data.messageId) || { role: "assistant" };
      meta.running = true;
      if (data.startedAt) meta.createdAt = data.startedAt;
      if (data.startedBy) meta.startedBy = data.startedBy;
      messageMeta.set(data.messageId, meta);
      updateBubbleMeta(data.messageId);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("assistant_done", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.message) {
        setBubbleText(data.message.id, data.message.text || "");
        messageMeta.set(data.message.id, {
          role: "assistant",
          createdAt: data.message.createdAt,
          completedAt: data.message.completedAt,
          durationMs: data.message.durationMs,
          startedBy: data.message.startedBy,
          status: data.message.status || data.result?.status,
          running: false,
          text: data.message.text || "",
        });
        updateBubbleMeta(data.message.id);
        ensureBubble(data.message);
        if (Array.isArray(data.message.artifactPaths)) {
          for (const p of data.message.artifactPaths) addDownloadButton(data.message.id, p);
        }
      }
      if (!currentDecision) {
        setBusy(false, null, "assistant_done");
        renderActivity([]);
      }
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("status", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (data.message) console.debug("[status]", data.message);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("agent_activity", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      renderActivity(data.lines || [], data.elapsedMs);
      if (data.startedAt) startTurnClock(data.startedAt);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("decision", (ev) => {
    try {
      renderDecision(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("decision_resolved", (ev) => {
    try {
      renderDecisionResolved(JSON.parse(ev.data));
    } catch {
      hideDecisionCard();
    }
  });

  es.addEventListener("composer_draft", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      if (!data || data.clientId === myClientId) return;
      showTyping(data.displayName);
      if (localTyping && document.activeElement === textEl) return;
      applyingRemoteDraft = true;
      textEl.value = typeof data.text === "string" ? data.text : "";
      applyingRemoteDraft = false;
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("artifact", (ev) => {
    try {
      const art = JSON.parse(ev.data);
      const messageId =
        art.messageId ||
        [...messageMeta.entries()].reverse().find(([, m]) => m.role === "assistant" && m.running)?.[0];
      if (messageId) addDownloadButton(messageId, art.path, art.kind);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("message_deleted", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyMessageDeleted(data.id, data.deletedBy);
    } catch {
      /* ignore */
    }
  });

  es.addEventListener("history_cleared", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      applyHistoryCleared(data.clearedBy);
    } catch {
      applyHistoryCleared("");
    }
  });

  es.addEventListener("room_error", (ev) => {
    try {
      const data = JSON.parse(ev.data);
      appendSystem(data.error || t("ui.roomError"));
      if (data.messageId) {
        const meta = messageMeta.get(data.messageId);
        if (meta) {
          meta.running = false;
          meta.status = "error";
          meta.completedAt = Date.now();
          if (meta.createdAt) meta.durationMs = meta.completedAt - meta.createdAt;
          messageMeta.set(data.messageId, meta);
          updateBubbleMeta(data.messageId);
        }
      }
      if (!currentDecision) {
        setBusy(false, null, "room_error");
        renderActivity([]);
      }
    } catch {
      appendSystem(t("ui.roomError"));
      if (!currentDecision) setBusy(false, null, "room_error-parse");
    }
  });

  es.onerror = () => {
    console.warn("[events] connection interrupted; reconnecting…");
  };

  return es;
}

filesEl.addEventListener("change", () => {
  const selected = Array.from(filesEl.files || []);
  pendingFiles = pendingFiles.concat(selected);
  filesEl.value = "";
  renderChips();
});

textEl.addEventListener("focus", () => {
  localTyping = true;
});

textEl.addEventListener("blur", () => {
  localTyping = false;
  void publishDraft(textEl.value);
});

textEl.addEventListener("input", () => {
  if (applyingRemoteDraft) return;
  localTyping = true;
  scheduleDraftPublish();
});

textEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

function syncDeleteControl(messageId) {
  const el = bubbleById.get(messageId);
  if (!el) return;
  const btn = el.querySelector(".bubble-delete");
  if (!btn) return;
  btn.hidden = Boolean(messageMeta.get(messageId)?.running);
}

function applyMessageDeleted(messageId, deletedBy) {
  const el = bubbleById.get(messageId);
  if (el) el.remove();
  bubbleById.delete(messageId);
  messageMeta.delete(messageId);
  downloadsByMessage.delete(messageId);
  if (pendingDeleteId === messageId) pendingDeleteId = null;
  if (deletedBy) appendSystem(t("delete.done", { name: deletedBy }));
}

function closeDeleteMessageDialog() {
  pendingDeleteId = null;
  if (typeof deleteMessageDialog.close === "function") {
    deleteMessageDialog.close();
  }
}

function openDeleteMessageDialog(messageId) {
  const meta = messageMeta.get(messageId);
  if (!messageId || meta?.running) return;
  pendingDeleteId = messageId;
  deleteMessageError.hidden = true;
  deleteMessageError.textContent = "";
  deleteMessageConfirm.disabled = false;
  if (typeof deleteMessageDialog.showModal === "function") {
    deleteMessageDialog.showModal();
  }
}

deleteMessageCancel.addEventListener("click", () => {
  closeDeleteMessageDialog();
});

deleteMessageDialog.addEventListener("click", (ev) => {
  if (ev.target === deleteMessageDialog) closeDeleteMessageDialog();
});

deleteMessageConfirm.addEventListener("click", async () => {
  const id = pendingDeleteId;
  if (!id) return;
  deleteMessageError.hidden = true;
  deleteMessageConfirm.disabled = true;
  try {
    const res = await fetch("/api/history/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = "/";
      return;
    }
    if (!res.ok) {
      throw new Error(data.error || t("delete.failed"));
    }
    closeDeleteMessageDialog();
  } catch (err) {
    deleteMessageError.textContent = err instanceof Error ? err.message : t("delete.failed");
    deleteMessageError.hidden = false;
  } finally {
    deleteMessageConfirm.disabled = false;
  }
});

function applyHistoryCleared(clearedBy) {
  closeDeleteMessageDialog();
  messagesEl.innerHTML = "";
  bubbleById.clear();
  messageMeta.clear();
  downloadsByMessage.clear();
  historyHasMore = false;
  oldestLoadedId = null;
  loadingOlder = false;
  if (historyLoader) messagesEl.appendChild(historyLoader);
  syncHistoryLoader();
  renderActivity([]);
  stopTurnClock();
  appendSystem(t("clear.done", { name: clearedBy || t("meta.user") }));
  scrollToBottom(true);
}

function closeClearHistoryDialog() {
  if (typeof clearHistoryDialog.close === "function") {
    clearHistoryDialog.close();
  }
}

clearHistoryBtn.addEventListener("click", () => {
  if (roomBusy) return;
  clearHistoryError.hidden = true;
  clearHistoryError.textContent = "";
  clearHistoryConfirm.disabled = false;
  if (typeof clearHistoryDialog.showModal === "function") {
    clearHistoryDialog.showModal();
  }
});

clearHistoryCancel.addEventListener("click", () => {
  closeClearHistoryDialog();
});

clearHistoryDialog.addEventListener("click", (ev) => {
  if (ev.target === clearHistoryDialog) closeClearHistoryDialog();
});

clearHistoryConfirm.addEventListener("click", async () => {
  clearHistoryError.hidden = true;
  clearHistoryConfirm.disabled = true;
  try {
    const res = await fetch("/api/history/clear", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      location.href = "/";
      return;
    }
    if (!res.ok) {
      throw new Error(data.error || t("clear.failed"));
    }
    closeClearHistoryDialog();
  } catch (err) {
    clearHistoryError.textContent = err instanceof Error ? err.message : t("clear.failed");
    clearHistoryError.hidden = false;
  } finally {
    clearHistoryConfirm.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  try {
    await rtc.leave();
  } catch {
    /* ignore */
  }
  await fetch("/api/logout", { method: "POST" });
  location.href = "/";
});

async function ensureAuth() {
  const res = await fetch("/api/me");
  const data = await res.json();
  if (!data.authenticated) {
    location.href = "/";
    return null;
  }
  myClientId = data.clientId;
  myDisplayName = data.displayName;
  meLabel.textContent = data.displayName
    ? t("chat.meRoom", { name: data.displayName })
    : t("chat.sharedRoom");
  setBusy(data.busy, data.busyBy, "/api/me");
  renderDecision(data.pendingDecision || null);
  return data;
}

async function sendMessage(text, files) {
  const formData = new FormData();
  formData.append("text", text);
  for (const file of files) {
    formData.append("files", file, file.name);
  }

  const res = await fetch("/api/chat", {
    method: "POST",
    body: formData,
  });

  if (res.status === 401) {
    location.href = "/";
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (roomBusy) {
    console.warn("[ui] submit blocked: roomBusy=true");
    return;
  }

  const text = textEl.value.trim();
  const files = pendingFiles.slice();
  if (!text && files.length === 0) return;

  sendBtn.disabled = true;
  pinToBottom = true;
  textEl.value = "";
  pendingFiles = [];
  renderChips();
  void publishDraft("");
  startTurnClock(Date.now());

  try {
    await sendMessage(text, files);
  } catch (err) {
    console.warn("[ui] submit fail", err);
    appendSystem(err instanceof Error ? err.message : t("ui.sendFailed"));
  } finally {
    try {
      const res = await fetch("/api/me");
      const data = await res.json();
      if (data.authenticated) {
        setBusy(data.busy, data.busyBy, "post-submit-/api/me");
      } else {
        setBusy(false, null, "post-submit-unauth");
      }
    } catch {
      setBusy(roomBusy, null, "post-submit-fallback");
    }
    textEl.focus();
  }
});

await ensureAuth();
updateLiveControls();
connectEvents();
window.addEventListener("beforeunload", () => {
  if (rtc.isInLive()) {
    void fetch("/api/rtc/leave", { method: "POST", keepalive: true, credentials: "same-origin" });
  }
});
