import { randomBytes } from "node:crypto";
import type { ArtifactRecord } from "./artifacts.js";
import { listArtifacts } from "./artifacts.js";
import { loadHistory, type HistoryMessage } from "./history.js";

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
  | "busy"
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
  clientId: string;
  displayName: string;
  send: (event: RoomEvent) => void;
};

const subscribers = new Map<string, Subscriber>();
const presence = new Map<string, PresenceMember>();
const rtcPeers = new Map<string, RtcPeer>();

let agentBusy = false;
let busyBy: { clientId: string; displayName: string } | null = null;
let streamingMessageId: string | null = null;

export function isRoomBusy(): boolean {
  return agentBusy;
}

export function getBusyBy(): { clientId: string; displayName: string } | null {
  return busyBy;
}

export function setRoomBusy(user: { clientId: string; displayName: string } | null): void {
  agentBusy = Boolean(user);
  busyBy = user;
  console.log(
    `[room] busy=${agentBusy} by=${busyBy?.displayName ?? "-"} subscribers=${subscribers.size}`,
  );
  broadcast({
    type: "busy",
    data: {
      busy: agentBusy,
      by: busyBy,
    },
    at: Date.now(),
  });
}

export function setStreamingMessageId(id: string | null): void {
  streamingMessageId = id;
}

export function getStreamingMessageId(): string | null {
  return streamingMessageId;
}

export function broadcast(event: RoomEvent): void {
  if (
    event.type !== "assistant_token" &&
    event.type !== "composer_draft" &&
    event.type !== "rtc_signal"
  ) {
    console.log(
      `[room] broadcast type=${event.type} subscribers=${subscribers.size}`,
    );
  }
  for (const sub of subscribers.values()) {
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

export function sendToClient(clientId: string, event: RoomEvent): number {
  let n = 0;
  for (const sub of subscribers.values()) {
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
  artifact: ArtifactRecord,
  extra?: { messageId?: string },
): void {
  broadcast({
    type: "artifact",
    data: { ...artifact, messageId: extra?.messageId },
    at: Date.now(),
  });
}

export function publishArtifacts(
  list: ArtifactRecord[],
  extra?: { messageId?: string },
): void {
  for (const artifact of list) publishArtifact(artifact, extra);
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
    if (now - member.lastSeenAt > 60_000 && ![...subscribers.values()].some((s) => s.clientId === id)) {
      presence.delete(id);
    }
  }
  return [...presence.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function emitPresence(): void {
  broadcast({
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
    broadcast({
      type: "rtc_peer_joined",
      data: { peer: self, peers: listRtcPeers() },
      at: Date.now(),
    });
  } else {
    broadcast({
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
  broadcast({
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

export async function buildSnapshot(): Promise<{
  messages: HistoryMessage[];
  artifacts: ArtifactRecord[];
  members: PresenceMember[];
  busy: boolean;
  busyBy: { clientId: string; displayName: string } | null;
  streamingMessageId: string | null;
  rtcPeers: RtcPeer[];
}> {
  const [messages, artifacts] = await Promise.all([loadHistory(), listArtifacts()]);
  return {
    messages,
    artifacts,
    members: presenceList(),
    busy: agentBusy,
    busyBy,
    streamingMessageId,
    rtcPeers: listRtcPeers(),
  };
}

export function subscribe(opts: {
  clientId: string;
  displayName: string;
  send: (event: RoomEvent) => void;
}): () => void {
  const id = randomBytes(8).toString("hex");
  const sub: Subscriber = {
    id,
    clientId: opts.clientId,
    displayName: opts.displayName,
    send: opts.send,
  };
  subscribers.set(id, sub);
  touchPresence(opts.clientId, opts.displayName);
  console.log(
    `[room] subscribe id=${id} client=${opts.displayName} total=${subscribers.size}`,
  );
  emitPresence();

  return () => {
    subscribers.delete(id);
    console.log(
      `[room] unsubscribe id=${id} client=${opts.displayName} total=${subscribers.size}`,
    );
    const stillHere = [...subscribers.values()].some((s) => s.clientId === opts.clientId);
    if (!stillHere) {
      presence.delete(opts.clientId);
      leaveRtc(opts.clientId);
    }
    emitPresence();
  };
}

export function heartbeatPresence(clientId: string, displayName: string): void {
  touchPresence(clientId, displayName);
}

export function newMessageId(): string {
  return `m_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
}
