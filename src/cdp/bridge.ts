import { config } from "../config.js";
import type { StreamHandlers } from "../types.js";
import { CdpClient } from "./client.js";

const CHAT_INPUT_SELECTORS = [
  "#workbench\\.parts\\.auxiliarybar [contenteditable='true']",
  ".composer-bar [contenteditable='true']",
  ".aislash-editor-input",
  "[contenteditable='true']",
];

/** How many unchanged polls before we even start the post-idle grace window. */
const STABLE_TICKS_REQUIRED = 15;
/** Keep watching after seeming idle in case a final answer still arrives. */
const IDLE_GRACE_MS = 25_000;

type CdpTarget = {
  id: string;
  type: string;
  title?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type ChatSnapshot = {
  humanCount: number;
  assistantTexts: string[];
  lastHuman: string;
  generating: boolean;
  /** Historical tool/status lines for the activity strip (may linger in DOM). */
  activityLines: string[];
  /** True only for live-in-progress signals — drives turn end. */
  liveWorking: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function activityKey(lines: string[]): string {
  return lines.join("\n");
}

async function listTargets(cdpHttpUrl: string): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpHttpUrl.replace(/\/$/, "")}/json`);
  if (!res.ok) throw new Error(`CDP /json failed: HTTP ${res.status}`);
  return (await res.json()) as CdpTarget[];
}

function listWorkbenchPages(targets: CdpTarget[]): CdpTarget[] {
  return targets.filter(
    (t) =>
      t.type === "page" &&
      t.webSocketDebuggerUrl &&
      (t.url || "").includes("workbench") &&
      !/^Cursor Agents$/i.test(t.title || ""),
  );
}

function titleMatchesTarget(title: string | undefined, needle: string): boolean {
  if (!needle) return false;
  return (title || "").toLowerCase().includes(needle.toLowerCase());
}

async function readWorkspaceHint(client: CdpClient): Promise<string> {
  try {
    return await client.evaluate<string>(`document.title || ''`);
  } catch {
    return "";
  }
}

async function pickWorkbenchTarget(targets: CdpTarget[]): Promise<{
  target: CdpTarget;
  windows: Array<{ title?: string; id: string; matched: boolean }>;
  matchMode: "title" | "fallback";
}> {
  const workbench = listWorkbenchPages(targets);
  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const needle = config.cursorCdpTarget;
  const cwdHint = config.cursorCwd.toLowerCase();

  const windows = (workbench.length ? workbench : pages).map((t) => ({
    title: t.title,
    id: t.id,
    matched: titleMatchesTarget(t.title, needle) || titleMatchesTarget(t.title, basenameHint(cwdHint)),
  }));

  const byTitle =
    workbench.find((t) => titleMatchesTarget(t.title, needle)) ||
    workbench.find((t) => titleMatchesTarget(t.title, basenameHint(cwdHint)));

  if (byTitle) {
    return { target: byTitle, windows, matchMode: "title" };
  }

  for (const candidate of workbench) {
    const client = new CdpClient();
    try {
      await client.connect(candidate.webSocketDebuggerUrl!);
      await client.send("Runtime.enable");
      const hint = (await readWorkspaceHint(client)).toLowerCase();
      if (hint.includes(needle) || hint.includes(basenameHint(cwdHint))) {
        client.disconnect();
        return {
          target: candidate,
          windows: windows.map((w) =>
            w.id === candidate.id ? { ...w, matched: true, title: candidate.title } : w,
          ),
          matchMode: "title",
        };
      }
    } catch {
      // try next
    } finally {
      client.disconnect();
    }
  }

  const preferred = workbench[0] || pages[0];
  if (!preferred?.webSocketDebuggerUrl) {
    throw new Error(
      "No Cursor window found on CDP. Open Cursor with --remote-debugging-port=9222.",
    );
  }

  if (needle && workbench.length > 0) {
    const open = windows.map((w) => w.title || w.id).join(" | ");
    throw new Error(
      `Project window "${needle}" was not found on CDP. ` +
        `Open the project folder in a Cursor window (File → New Window → Open Folder). ` +
        `Windows now: ${open || "(none)"}`,
    );
  }

  return { target: preferred, windows, matchMode: "fallback" };
}

function basenameHint(cwd: string): string {
  const parts = cwd.replace(/\/+$/, "").split("/");
  return (parts[parts.length - 1] || "").toLowerCase();
}

async function connectToWorkbench(): Promise<{
  client: CdpClient;
  target: CdpTarget;
  windows: Array<{ title?: string; id: string; matched: boolean }>;
  matchMode: "title" | "fallback";
}> {
  const targets = await listTargets(config.cursorCdpUrl);
  const picked = await pickWorkbenchTarget(targets);
  const client = new CdpClient();
  await client.connect(picked.target.webSocketDebuggerUrl!);
  await client.send("Runtime.enable");
  return { client, target: picked.target, windows: picked.windows, matchMode: picked.matchMode };
}

async function snapshotChat(client: CdpClient): Promise<ChatSnapshot> {
  return client.evaluate<ChatSnapshot>(`(() => {
    const humans = [...document.querySelectorAll('[data-message-role="human"]')];
    const assistants = [...document.querySelectorAll('[data-message-role="ai"][data-message-kind="assistant"]')];
    const generating = !!(
      document.querySelector('[aria-label*="Stop" i]') ||
      document.querySelector('button[aria-label*="Stop" i]') ||
      document.querySelector('.composer-stop-button') ||
      document.querySelector('[class*="generating"]') ||
      document.querySelector('[class*="stop-generating"]') ||
      document.querySelector('[data-stop-button]')
    );

    // Historical / informational (shown in the panel; must NOT block turn end).
    const historyRe = /^(Exploring|Explored|Planning next moves|Thinking|Reading|Searching|Running|Wrote|Edited|Confirmando|Analisando|Considered|Grep|Shell|Query|Web search|Listed|Glob)/i;
    const raw = (document.body && document.body.innerText) ? document.body.innerText : '';
    const lines = raw.split('\\n').map((s) => s.trim()).filter(Boolean);
    const activityLines = [];
    const seen = new Set();
    for (let i = lines.length - 1; i >= 0 && activityLines.length < 12; i--) {
      const line = lines[i];
      if (line.length > 240) continue;
      const interesting =
        historyRe.test(line) ||
        line.startsWith('>_') ||
        /^\\d+\\s+(file|search|files|searches)/i.test(line);
      if (!interesting) continue;
      if (seen.has(line)) continue;
      seen.add(line);
      activityLines.unshift(line);
    }

    // Live-only status: in-progress phrases / active tools — not finished tool cards.
    function isLiveStatusLine(line) {
      if (!line || line.length > 160) return false;
      if (/^Explored\\s+\\d+/i.test(line)) return false;
      if (line.startsWith('>_')) return false;
      if (/^\\d+\\s+(file|search|files|searches)/i.test(line)) return false;
      if (/^(Planning next moves|Thinking|Exploring|Confirmando|Analisando|Gerando)/i.test(line)) return true;
      // Active tool progress (ellipsis / …) — completed cards usually lack this.
      if (/^(Running|Shell|Reading|Searching|Grep|Query|Web search|Listed|Glob)\\b/i.test(line) && /(?:\\u2026|\\.\\.\\.)$/.test(line)) {
        return true;
      }
      // Finished tool cards (no progress marker) must not block turn end.
      if (/^(Grep|Shell|Query|Web search|Listed|Glob|Wrote|Edited|Reading|Searching|Running|Considered)\\b/i.test(line)) {
        return false;
      }
      return false;
    }

    const recent = lines.slice(-50);
    // Prefer text status over broad DOM class guesses (aria-busy/spinner can linger globally).
    const liveWorking = recent.some(isLiveStatusLine);

    return {
      humanCount: humans.length,
      assistantTexts: assistants.map((el) => (el.innerText || '').trim()),
      lastHuman: humans.length ? (humans[humans.length - 1].innerText || '').trim() : '',
      generating,
      activityLines,
      liveWorking,
    };
  })()`);
}

function emitActivity(
  handlers: StreamHandlers,
  snap: ChatSnapshot,
  prevKey: { value: string },
): void {
  if (!handlers.onActivity) return;
  const lines = [...snap.activityLines];
  if (snap.generating && !lines.some((l) => /gerando|generating|stop/i.test(l))) {
    lines.unshift("Generating…");
  } else if (snap.liveWorking && lines.length === 0) {
    lines.unshift("Working…");
  }
  const key = activityKey(lines);
  if (key === prevKey.value) return;
  prevKey.value = key;
  handlers.onActivity(lines);
}

async function focusChatInput(client: CdpClient): Promise<string> {
  const result = await client.evaluate<{ ok: boolean; info?: string; error?: string }>(`(() => {
    const strategies = ${JSON.stringify(CHAT_INPUT_SELECTORS)};
    let input = null;
    let matched = '';
    for (const sel of strategies) {
      try {
        input = document.querySelector(sel);
        if (input) { matched = sel; break; }
      } catch {}
    }
    if (!input) return { ok: false, error: 'Chat input not found. Open an Agent chat in Cursor.' };
    input.scrollIntoView({ block: 'center', behavior: 'instant' });
    input.focus();
    input.click();
    return { ok: true, info: input.tagName + ' | ' + matched };
  })()`);

  if (!result?.ok) throw new Error(result?.error || "Failed to focus the Cursor input");
  return result.info || "input";
}

async function sendPromptToComposer(client: CdpClient, text: string): Promise<void> {
  const info = await focusChatInput(client);
  console.log(`[cdp] focused ${info}`);
  await sleep(120);

  await client.pressKey("a", "KeyA", 65, 2);
  await sleep(40);
  await client.pressKey("Backspace", "Backspace", 8);
  await sleep(40);

  await client.typeText(text);
  await sleep(150);
  await client.pressKey("Enter", "Enter", 13);
  await sleep(250);

  const stillThere = await client.evaluate<boolean>(`(() => {
    const strategies = ${JSON.stringify(CHAT_INPUT_SELECTORS)};
    const typed = ${JSON.stringify(text.trim())};
    let input = null;
    for (const sel of strategies) {
      try { input = document.querySelector(sel); if (input) break; } catch {}
    }
    if (!input || !typed) return false;
    const current = ((input.isContentEditable ? (input.innerText || input.textContent) : (input.value || '')) || '').trim();
    return current.length > 0 && current.includes(typed);
  })()`);

  if (stillThere) {
    console.log("[cdp] retry submit with Ctrl+Enter");
    await client.pressKey("Enter", "Enter", 13, 2);
  }
}

export async function checkCdpHealth(): Promise<{
  ok: boolean;
  cdpUrl: string;
  wantTarget?: string;
  browser?: string;
  targetTitle?: string;
  matchMode?: string;
  windows?: Array<{ title?: string; id: string; matched: boolean }>;
  hasChatInput?: boolean;
  error?: string;
}> {
  try {
    const versionRes = await fetch(`${config.cursorCdpUrl.replace(/\/$/, "")}/json/version`);
    if (!versionRes.ok) {
      return { ok: false, cdpUrl: config.cursorCdpUrl, wantTarget: config.cursorCdpTarget, error: `HTTP ${versionRes.status} em /json/version` };
    }
    const version = (await versionRes.json()) as { Browser?: string };
    const { client, target, windows, matchMode } = await connectToWorkbench();
    try {
      const hasChatInput = await client.evaluate<boolean>(`(() => {
        const strategies = ${JSON.stringify(CHAT_INPUT_SELECTORS)};
        for (const sel of strategies) {
          try { if (document.querySelector(sel)) return true; } catch {}
        }
        return false;
      })()`);
      return {
        ok: true,
        cdpUrl: config.cursorCdpUrl,
        wantTarget: config.cursorCdpTarget,
        browser: version.Browser,
        targetTitle: target.title,
        matchMode,
        windows,
        hasChatInput,
      };
    } finally {
      client.disconnect();
    }
  } catch (err) {
    let windows: Array<{ title?: string; id: string; matched: boolean }> | undefined;
    try {
      const targets = await listTargets(config.cursorCdpUrl);
      windows = listWorkbenchPages(targets).map((t) => ({
        title: t.title,
        id: t.id,
        matched: titleMatchesTarget(t.title, config.cursorCdpTarget),
      }));
    } catch {
      // ignore
    }
    return {
      ok: false,
      cdpUrl: config.cursorCdpUrl,
      wantTarget: config.cursorCdpTarget,
      windows,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runCdpChatTurn(opts: {
  text: string;
  handlers: StreamHandlers;
}): Promise<{ agentId: string; runId: string; status: string }> {
  const prompt = opts.text.trim();
  if (!prompt) throw new Error("Send text for CDP mode (CDP attachments are not supported yet).");

  const { client, target } = await connectToWorkbench();
  opts.handlers.onStatus(`cdp=${target.title || target.id} (want=${config.cursorCdpTarget})`);

  try {
    const before = await snapshotChat(client);
    await sendPromptToComposer(client, prompt);

    const waitStart = Date.now();
    while (Date.now() - waitStart < 8_000) {
      const snap = await snapshotChat(client);
      if (snap.humanCount > before.humanCount || snap.generating || snap.lastHuman.includes(prompt.slice(0, 40))) {
        break;
      }
      await sleep(200);
    }

    let lastAssistant = "";
    let stableTicks = 0;
    let sawGenerating = false;
    let sawLiveWorking = false;
    let sawActivityHist = false;
    let idleSince: number | null = null;
    let lastDiagAt = 0;
    let stillWorkingAtEnd = false;
    const activityPrev = { value: "" };
    const turnStart = Date.now();
    const hardCap = turnStart + config.cdpMaxTimeoutMs;
    let deadline = Math.min(turnStart + config.cdpTimeoutMs, hardCap);
    const baselineAssistants = before.assistantTexts.length;
    let endReason = "timeout";

    while (Date.now() < deadline) {
      const snap = await snapshotChat(client);
      if (snap.generating) sawGenerating = true;
      if (snap.liveWorking) sawLiveWorking = true;
      if (snap.activityLines.length > 0) sawActivityHist = true;

      emitActivity(opts.handlers, snap, activityPrev);

      const assistants = snap.assistantTexts;
      const candidate =
        assistants.length > baselineAssistants
          ? assistants[assistants.length - 1]
          : assistants.length
            ? assistants[assistants.length - 1]
            : "";

      // Do NOT use historical activityLines here — finished Grep/Shell cards linger in the DOM.
      const stillWorking = snap.generating || snap.liveWorking;
      stillWorkingAtEnd = stillWorking;

      // Soft-extend while the agent is active; never past the absolute hard cap.
      if (stillWorking) {
        deadline = Math.min(Date.now() + config.cdpTimeoutMs, hardCap);
      }

      if (Date.now() - lastDiagAt > 5_000) {
        lastDiagAt = Date.now();
        console.log(
          `[cdp] stillWorking generating=${snap.generating} live=${snap.liveWorking} activityHist=${snap.activityLines.length} len=${lastAssistant.length} stable=${stableTicks} elapsed=${Date.now() - turnStart}ms deadlineLeft=${Math.max(0, deadline - Date.now())}ms`,
        );
      }

      if (candidate && candidate !== lastAssistant) {
        if (candidate.startsWith(lastAssistant)) {
          const delta = candidate.slice(lastAssistant.length);
          if (delta) opts.handlers.onText(delta);
        } else if (!lastAssistant) {
          opts.handlers.onText(candidate);
        } else if (opts.handlers.onReplace) {
          opts.handlers.onStatus("cdp-assistant-replace");
          opts.handlers.onReplace(candidate);
        } else {
          opts.handlers.onStatus("cdp-dom-refresh");
          opts.handlers.onText(`\n${candidate}`);
        }
        lastAssistant = candidate;
        stableTicks = 0;
        idleSince = null;
      } else if (!stillWorking) {
        stableTicks += 1;
      } else {
        stableTicks = 0;
        idleSince = null;
      }

      if (stillWorking) {
        await sleep(config.cdpPollMs);
        continue;
      }

      const readyToGrace =
        lastAssistant.length > 0 &&
        stableTicks >= STABLE_TICKS_REQUIRED &&
        (sawGenerating || sawLiveWorking || sawActivityHist);

      if (readyToGrace) {
        if (idleSince === null) {
          idleSince = Date.now();
          console.log(
            `[cdp] idle candidate len=${lastAssistant.length} starting grace ${IDLE_GRACE_MS}ms`,
          );
          opts.handlers.onActivity?.(["Aguardando resposta final…"]);
        } else if (Date.now() - idleSince >= IDLE_GRACE_MS) {
          endReason = "stable+grace";
          break;
        }
      }

      await sleep(config.cdpPollMs);
    }

    let status: string;
    if (endReason === "stable+grace") {
      status = "finished";
    } else if (!lastAssistant) {
      opts.handlers.onStatus("sem texto assistente detectado (talvez ainda gerando no IDE)");
      endReason = "empty";
      status = "empty";
    } else {
      status = "timeout";
      opts.handlers.onStatus(
        "timeout: bridge parou de observar; Cursor pode ainda estar rodando",
      );
      opts.handlers.onActivity?.([
        "Timeout — resposta parcial; Cursor pode ainda estar rodando",
      ]);
    }

    console.log(
      `[cdp] turn end reason=${endReason} status=${status} len=${lastAssistant.length} elapsed=${Date.now() - turnStart}ms stillWorkingAtEnd=${stillWorkingAtEnd} sawGenerating=${sawGenerating} sawLive=${sawLiveWorking} sawActivityHist=${sawActivityHist}`,
    );
    if (status !== "timeout") {
      opts.handlers.onActivity?.([]);
    }

    return {
      agentId: `cdp:${target.id}`,
      runId: `cdp-${Date.now()}`,
      status,
    };
  } finally {
    client.disconnect();
  }
}
