/**
 * WebRTC mesh live for the shared room.
 * Signaling goes through /api/rtc/* + SSE rtc_* events.
 */
import { t } from "./i18n.js?v=4";

/** @typedef {{ clientId: string, displayName: string, joinedAt?: number }} RtcPeerInfo */

export function createRoomRtc(opts) {
  const {
    getClientId,
    getDisplayName,
    onPeersChanged,
    tilesEl,
    statusEl,
  } = opts;

  /** @type {MediaStream | null} */
  let localStream = null;
  /** @type {Map<string, RTCPeerConnection>} */
  const pcs = new Map();
  /** @type {Map<string, RtcPeerInfo>} */
  const peers = new Map();
  /** @type {RTCIceServer[]} */
  let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
  let inLive = false;
  let micEnabled = true;
  let camEnabled = true;
  /** Preferential offerer: lower clientId creates the offer (avoid glare). */
  const shouldOffer = (remoteId) => getClientId() < remoteId;

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text || "";
  }

  function renderTiles() {
    if (!tilesEl) return;
    tilesEl.innerHTML = "";

    if (localStream) {
      const tile = document.createElement("div");
      tile.className = "live-tile local";
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.muted = true;
      video.srcObject = localStream;
      const label = document.createElement("div");
      label.className = "live-tile-label";
      label.textContent = t("live.you", { name: getDisplayName() || t("live.youFallback") });
      tile.appendChild(video);
      tile.appendChild(label);
      tilesEl.appendChild(tile);
    }

    for (const [id, peer] of peers) {
      if (id === getClientId()) continue;
      const tile = document.createElement("div");
      tile.className = "live-tile remote";
      tile.dataset.clientId = id;
      const video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      video.id = `live-video-${id}`;
      const label = document.createElement("div");
      label.className = "live-tile-label";
      label.textContent = peer.displayName || id.slice(0, 8);
      tile.appendChild(video);
      tile.appendChild(label);
      tilesEl.appendChild(tile);

      const pc = pcs.get(id);
      if (pc) {
        const stream = new MediaStream();
        for (const receiver of pc.getReceivers()) {
          if (receiver.track) stream.addTrack(receiver.track);
        }
        if (stream.getTracks().length) video.srcObject = stream;
      }
    }

    onPeersChanged?.([...peers.values()], inLive);
  }

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  async function signal(toClientId, payload) {
    await postJson("/api/rtc/signal", { toClientId, ...payload });
  }

  function attachRemoteTrack(remoteId, track) {
    let video = document.getElementById(`live-video-${remoteId}`);
    if (!video) {
      renderTiles();
      video = document.getElementById(`live-video-${remoteId}`);
    }
    if (!video) return;
    let stream = video.srcObject;
    if (!(stream instanceof MediaStream)) {
      stream = new MediaStream();
      video.srcObject = stream;
    }
    if (!stream.getTracks().some((t) => t.id === track.id)) {
      stream.addTrack(track);
    }
  }

  function createPc(remoteId) {
    if (pcs.has(remoteId)) return pcs.get(remoteId);
    const pc = new RTCPeerConnection({ iceServers });
    pcs.set(remoteId, pc);

    if (localStream) {
      for (const track of localStream.getTracks()) {
        pc.addTrack(track, localStream);
      }
    }

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      void signal(remoteId, { type: "ice", candidate: ev.candidate.toJSON() }).catch((err) => {
        console.warn("[rtc] ice signal failed", err);
      });
    };

    pc.ontrack = (ev) => {
      attachRemoteTrack(remoteId, ev.track);
    };

    pc.onconnectionstatechange = () => {
      console.debug(`[rtc] pc ${remoteId} state=${pc.connectionState}`);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        // keep tile; user can leave/rejoin
      }
    };

    return pc;
  }

  async function makeOffer(remoteId) {
    const pc = createPc(remoteId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await signal(remoteId, { type: "offer", sdp: pc.localDescription });
  }

  async function handleSignal(data) {
    const fromId = data.fromClientId;
    if (!fromId || fromId === getClientId()) return;
    if (!inLive) return;

    if (data.fromDisplayName) {
      peers.set(fromId, {
        clientId: fromId,
        displayName: data.fromDisplayName,
        joinedAt: peers.get(fromId)?.joinedAt || Date.now(),
      });
    }

    if (data.type === "offer") {
      const pc = createPc(fromId);
      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await signal(fromId, { type: "answer", sdp: pc.localDescription });
      renderTiles();
      return;
    }

    if (data.type === "answer") {
      const pc = pcs.get(fromId) || createPc(fromId);
      await pc.setRemoteDescription(data.sdp);
      return;
    }

    if (data.type === "ice" && data.candidate) {
      const pc = pcs.get(fromId) || createPc(fromId);
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        console.warn("[rtc] addIceCandidate", err);
      }
    }
  }

  async function connectToPeer(peer) {
    if (!peer?.clientId || peer.clientId === getClientId()) return;
    peers.set(peer.clientId, peer);
    createPc(peer.clientId);
    if (shouldOffer(peer.clientId)) {
      await makeOffer(peer.clientId);
    }
    renderTiles();
  }

  function removePeer(clientId) {
    const pc = pcs.get(clientId);
    if (pc) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
      pcs.delete(clientId);
    }
    peers.delete(clientId);
    renderTiles();
  }

  async function join() {
    if (inLive) return;
    setStatus(t("live.askingMedia"));
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 360 } },
    });
    for (const t of localStream.getAudioTracks()) t.enabled = micEnabled;
    for (const t of localStream.getVideoTracks()) t.enabled = camEnabled;

    const data = await postJson("/api/rtc/join", {});
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      iceServers = data.iceServers;
    }
    inLive = true;
    peers.clear();
    for (const p of data.peers || []) {
      if (p.clientId !== getClientId()) peers.set(p.clientId, p);
    }
    setStatus(t("live.inLive"));
    renderTiles();

    for (const p of peers.values()) {
      await connectToPeer(p);
    }
  }

  async function leave() {
    if (!inLive && !localStream) return;
    try {
      await postJson("/api/rtc/leave", {});
    } catch {
      /* ignore */
    }
    for (const pc of pcs.values()) {
      try {
        pc.close();
      } catch {
        /* ignore */
      }
    }
    pcs.clear();
    peers.clear();
    if (localStream) {
      for (const t of localStream.getTracks()) t.stop();
      localStream = null;
    }
    inLive = false;
    setStatus("");
    renderTiles();
  }

  function setMicEnabled(on) {
    micEnabled = Boolean(on);
    if (localStream) {
      for (const t of localStream.getAudioTracks()) t.enabled = micEnabled;
    }
  }

  function setCamEnabled(on) {
    camEnabled = Boolean(on);
    if (localStream) {
      for (const t of localStream.getVideoTracks()) t.enabled = camEnabled;
    }
  }

  function handleEvent(name, data) {
    if (name === "snapshot" && Array.isArray(data.rtcPeers)) {
      // Only update roster display when not in live; join flow owns PCs.
      if (!inLive) {
        peers.clear();
        for (const p of data.rtcPeers) peers.set(p.clientId, p);
        onPeersChanged?.([...peers.values()], inLive);
      }
      return;
    }
    if (name === "rtc_peer_joined") {
      const peer = data.peer;
      if (inLive && peer && peer.clientId !== getClientId()) {
        void connectToPeer(peer);
      } else if (peer) {
        peers.set(peer.clientId, peer);
        onPeersChanged?.([...peers.values()], inLive);
      }
      return;
    }
    if (name === "rtc_peer_left") {
      const peer = data.peer;
      if (peer?.clientId) removePeer(peer.clientId);
      return;
    }
    if (name === "rtc_peers" && Array.isArray(data.peers)) {
      if (!inLive) {
        peers.clear();
        for (const p of data.peers) peers.set(p.clientId, p);
        onPeersChanged?.([...peers.values()], inLive);
      }
      return;
    }
    if (name === "rtc_signal") {
      void handleSignal(data).catch((err) => console.warn("[rtc] signal", err));
    }
  }

  function isInLive() {
    return inLive;
  }

  function getMicEnabled() {
    return micEnabled;
  }

  function getCamEnabled() {
    return camEnabled;
  }

  return {
    join,
    leave,
    handleEvent,
    setMicEnabled,
    setCamEnabled,
    isInLive,
    getMicEnabled,
    getCamEnabled,
  };
}
