import { randomBytes } from "node:crypto";
import type { ArtifactRecord } from "./artifacts.js";
import { HISTORY_PAGE, loadHistoryPage, type HistoryMessage } from "./history.js";
import type { PendingDecision } from "./types.js";

export type { PendingDecision } from "./types.js";

export type RoomEventType =
  | "snapshot"
  | "presence"
  | "user_message"
  | "assistant_token"
  | "assistant_replace"
  | "assistant_done"
  | "status"
  | "agent_activity"
  | "composer_draft"
  | "artifact"
  | "room_error"
  | "history_cleared"
  | "message_deleted"
  | "busy"
  | "decision"
  | "decision_resolved"
  | "rooms_status"
  | "rtc_peer_joined"
  | "rtc_peer_left"
  | "rtc_peers"
  | "rtc_signal";

export type RoomEvent = {
  type: RoomEventType;
  data: unknown;
  at: number;
};

export type PresenceMember = {
  clientId: string;
  displayName: string;
  lastSeenAt: number;
};

export type RtcPeer = {
  clientId: string;
  displayName: string;
  joinedAt: number;
};

type Subscriber = {
  id: string;
  roomId: string;
  clientId: string;
  displayName: string;
  send: (event: RoomEvent) => void;
};

type RoomRuntime = {
  busy: boolean;
  busyBy: { clientId: string; displayName: string } | null;
  streamingMessageId: string | null;
  pendingDecision: PendingDecision | null;
  decisionClaimed: boolean;
  suppressDecisionKey: string;
  suppressDecisionUntil: number;
  lastActivityAt: number | null;
  subscribers: Map<string, Subscriber>;
};

const runtimes = new Map<string, RoomRuntime>();
const processStartedAt = Date.now();
const statusSubscribers = new Map<string, (event: RoomEvent) => void>();
const presence = new Map<string, PresenceMember>();
const rtcPeers = new Map<string, RtcPeer>();

function runtime(roomId: string): RoomRuntime {
  let room = runtimes.get(roomId);
  if (!room) {
    room = {
      busy: false,
      busyBy: null,
      streamingMessageId: null,
      pendingDecision: null,
      decisionClaimed: false,
      suppressDecisionKey: "",
      suppressDecisionUntil: 0,
      lastActivityAt: null,
      subscribers: new Map(),
    };
    runtimes.set(roomId, room);
  }
  return room;
}

function allSubscribers(): Subscriber[] {
  return [...runtimes.values()].flatMap((room) => [...room.subscribers.values()]);
}

export function isRoomBusy(roomId: string): boolean {
  return runtime(roomId).busy;
}

export function touchRoomActivity(roomId: string): void {
  runtime(roomId).lastActivityAt = Date.now();
}

export function roomLastActivityAt(roomId: string): number {
  return runtimes.get(roomId)?.lastActivityAt ?? processStartedAt;
}

export function getBusyBy(roomId: string): { clientId: string; displayName: string } | null {
  return runtime(roomId).busyBy;
}

export function roomBusySnapshot(): Array<{
  id: string;
  busy: boolean;
  busyBy: { clientId: string; displayName: string } | null;
}> {
  return [...runtimes.entries()].map(([id, room]) => ({
    id,
    busy: room.busy,
    busyBy: room.busyBy,
  }));
}

function emitRoomsStatus(): void {
  const event: RoomEvent = {
    type: "rooms_status",
    data: { rooms: roomBusySnapshot() },
    at: Date.now(),
  };
  for (const send of statusSubscribers.values()) {
    try {
      send(event);
    } catch {
      // ignore a closed status stream
    }
  }
}

export function setRoomBusy(
  roomId: string,
  user: { clientId: string; displayName: string } | null,
): void {
  const room = runtime(roomId);
  room.busy = Boolean(user);
  room.busyBy = user;
  console.log(
    `[room] room=${roomId} busy=${room.busy} by=${room.busyBy?.displayName ?? "-"} subscribers=${room.subscribers.size}`,
  );
  broadcast(roomId, {
    type: "busy",
    data: { busy: room.busy, by: room.busyBy },
    at: Date.now(),
  });
  emitRoomsStatus();
}

export function setStreamingMessageId(roomId: string, id: string | null): void {
  runtime(roomId).streamingMessageId = id;
}

export function getStreamingMessageId(roomId: string): string | null {
  return runtime(roomId).streamingMessageId;
}

function sameDecision(a: PendingDecision | null, b: PendingDecision | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function getPendingDecision(roomId: string): PendingDecision | null {
  return runtime(roomId).pendingDecision;
}

export function setPendingDecision(roomId: string, decision: PendingDecision | null): void {
  const room = runtime(roomId);
  if (
    decision &&
    Date.now() < room.suppressDecisionUntil &&
    JSON.stringify(decision) === room.suppressDecisionKey
  ) {
    return;
  }
  if (sameDecision(room.pendingDecision, decision)) return;
  room.pendingDecision = decision;
  room.decisionClaimed = false;
  if (decision) {
    console.log(`[room] room=${roomId} decision kind=${decision.kind} options=${decision.options.length}`);
    broadcast(roomId, { type: "decision", data: decision, at: Date.now() });
  }
}

export function claimDecision(
  roomId: string,
  optionId: string,
):
  | { ok: true; decision: PendingDecision }
  | { ok: false; reason: "none" | "claimed" | "unknown" } {
  const room = runtime(roomId);
  if (!room.pendingDecision) return { ok: false, reason: "none" };
  if (room.decisionClaimed) return { ok: false, reason: "claimed" };
  if (!room.pendingDecision.options.some((option) => option.id === optionId)) {
    return { ok: false, reason: "unknown" };
  }
  room.decisionClaimed = true;
  return { ok: true, decision: room.pendingDecision };
}

export function releaseDecisionClaim(roomId: string): void {
  runtime(roomId).decisionClaimed = false;
}

export function clearPendingDecision(
  roomId: string,
  extra?: { by?: string; optionId?: string },
): void {
  const room = runtime(roomId);
  if (!room.pendingDecision) return;
  room.suppressDecisionKey = JSON.stringify(room.pendingDecision);
  room.suppressDecisionUntil = Date.now() + 4_000;
  room.pendingDecision = null;
  room.decisionClaimed = false;
  const by = extra?.by ?? "";
  const optionId = extra?.optionId ?? "";
  broadcast(roomId, {
    type: "decision_resolved",
    data: { by, optionId, dismissed: !optionId },
    at: Date.now(),
  });
  if (!room.streamingMessageId && room.busy) {
    setRoomBusy(roomId, null);
  }
}

export function broadcast(roomId: string, event: RoomEvent): void {
  const room = runtime(roomId);
  if (
    event.type !== "assistant_token" &&
    event.type !== "composer_draft" &&
    event.type !== "rtc_signal"
  ) {
    console.log(
      `[room] broadcast room=${roomId} type=${event.type} subscribers=${room.subscribers.size}`,
    );
  }
  for (const sub of room.subscribers.values()) {
    try {
      sub.send(event);
    } catch (err) {
      console.warn(
        `[room] subscriber send failed id=${sub.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

function broadcastGlobal(event: RoomEvent): void {
  for (const sub of allSubscribers()) {
    try {
      sub.send(event);
    } catch (err) {
      console.warn(
        `[room] global send failed id=${sub.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function sendToClient(clientId: string, event: RoomEvent): number {
  let n = 0;
  for (const sub of allSubscribers()) {
    if (sub.clientId !== clientId) continue;
    try {
      sub.send(event);
      n += 1;
    } catch (err) {
      console.warn(
        `[room] sendToClient failed id=${sub.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return n;
}

export function publishArtifact(
  roomId: string,
  artifact: ArtifactRecord,
  extra?: { messageId?: string },
): void {
  broadcast(roomId, {
    type: "artifact",
    data: { ...artifact, messageId: extra?.messageId },
    at: Date.now(),
  });
}

export function publishArtifacts(
  roomId: string,
  list: ArtifactRecord[],
  extra?: { messageId?: string },
): void {
  for (const artifact of list) publishArtifact(roomId, artifact, extra);
}

function touchPresence(clientId: string, displayName: string): void {
  presence.set(clientId, {
    clientId,
    displayName,
    lastSeenAt: Date.now(),
  });
}

function presenceList(): PresenceMember[] {
  const now = Date.now();
  for (const [id, member] of presence) {
    if (now - member.lastSeenAt > 60_000 && !allSubscribers().some((s) => s.clientId === id)) {
      presence.delete(id);
    }
  }
  return [...presence.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function emitPresence(): void {
  broadcastGlobal({
    type: "presence",
    data: { members: presenceList() },
    at: Date.now(),
  });
}

export function listRtcPeers(): RtcPeer[] {
  return [...rtcPeers.values()].sort((a, b) => a.joinedAt - b.joinedAt);
}

export function joinRtc(user: { clientId: string; displayName: string }): {
  peers: RtcPeer[];
  self: RtcPeer;
} {
  const self: RtcPeer = {
    clientId: user.clientId,
    displayName: user.displayName,
    joinedAt: Date.now(),
  };
  const already = rtcPeers.has(user.clientId);
  rtcPeers.set(user.clientId, self);
  if (!already) {
    broadcastGlobal({
      type: "rtc_peer_joined",
      data: { peer: self, peers: listRtcPeers() },
      at: Date.now(),
    });
  } else {
    broadcastGlobal({
      type: "rtc_peers",
      data: { peers: listRtcPeers() },
      at: Date.now(),
    });
  }
  console.log(`[rtc] join ${user.displayName} total=${rtcPeers.size}`);
  return { peers: listRtcPeers(), self };
}

export function leaveRtc(clientId: string): boolean {
  const peer = rtcPeers.get(clientId);
  if (!peer) return false;
  rtcPeers.delete(clientId);
  broadcastGlobal({
    type: "rtc_peer_left",
    data: { peer, peers: listRtcPeers() },
    at: Date.now(),
  });
  console.log(`[rtc] leave ${peer.displayName} total=${rtcPeers.size}`);
  return true;
}

export function relayRtcSignal(opts: {
  fromClientId: string;
  fromDisplayName: string;
  toClientId: string;
  payload: unknown;
}): boolean {
  if (!rtcPeers.has(opts.fromClientId)) return false;
  if (!rtcPeers.has(opts.toClientId)) return false;
  const n = sendToClient(opts.toClientId, {
    type: "rtc_signal",
    data: {
      fromClientId: opts.fromClientId,
      fromDisplayName: opts.fromDisplayName,
      ...((opts.payload && typeof opts.payload === "object") ? opts.payload : {}),
    },
    at: Date.now(),
  });
  return n > 0;
}

export async function buildSnapshot(roomId: string): Promise<{
  messages: HistoryMessage[];
  artifacts: ArtifactRecord[];
  historyHasMore: boolean;
  members: PresenceMember[];
  busy: boolean;
  busyBy: { clientId: string; displayName: string } | null;
  streamingMessageId: string | null;
  pendingDecision: PendingDecision | null;
  rtcPeers: RtcPeer[];
}> {
  const room = runtime(roomId);
  const page = await loadHistoryPage(roomId, { limit: HISTORY_PAGE });
  const messages = "error" in page ? [] : page.messages;
  const historyHasMore = "error" in page ? false : page.hasMore;
  return {
    messages,
    artifacts: [],
    historyHasMore,
    members: presenceList(),
    busy: room.busy,
    busyBy: room.busyBy,
    streamingMessageId: room.streamingMessageId,
    pendingDecision: room.pendingDecision,
    rtcPeers: listRtcPeers(),
  };
}

export function subscribe(opts: {
  roomId: string;
  clientId: string;
  displayName: string;
  send: (event: RoomEvent) => void;
}): () => void {
  const room = runtime(opts.roomId);
  const id = randomBytes(8).toString("hex");
  const sub: Subscriber = {
    id,
    roomId: opts.roomId,
    clientId: opts.clientId,
    displayName: opts.displayName,
    send: opts.send,
  };
  room.subscribers.set(id, sub);
  touchPresence(opts.clientId, opts.displayName);
  console.log(
    `[room] subscribe room=${opts.roomId} id=${id} client=${opts.displayName} total=${room.subscribers.size}`,
  );
  emitPresence();

  return () => {
    room.subscribers.delete(id);
    console.log(
      `[room] unsubscribe room=${opts.roomId} id=${id} client=${opts.displayName} total=${room.subscribers.size}`,
    );
    const stillHere = allSubscribers().some((item) => item.clientId === opts.clientId);
    if (!stillHere) {
      presence.delete(opts.clientId);
      leaveRtc(opts.clientId);
    }
    emitPresence();
  };
}

export function subscribeStatus(send: (event: RoomEvent) => void): () => void {
  const id = randomBytes(8).toString("hex");
  statusSubscribers.set(id, send);
  send({ type: "rooms_status", data: { rooms: roomBusySnapshot() }, at: Date.now() });
  return () => {
    statusSubscribers.delete(id);
  };
}

export function heartbeatPresence(clientId: string, displayName: string): void {
  touchPresence(clientId, displayName);
}

export function newMessageId(): string {
  return `m_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}
