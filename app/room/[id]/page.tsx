"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// ---- Types --------------------------------------------------

type RealtimeSubscribeStatus =
  | "SUBSCRIBED"
  | "CLOSED"
  | "TIMED_OUT"
  | "CHANNEL_ERROR";

type WebRTCPayload = {
  type: "offer" | "answer" | "ice";
  from: string;
  to?: string;
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

type Peer = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
};

type PeerStreams = Record<string, MediaStream>;

// ---- Component ----------------------------------------------

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = (params?.id as string) ?? "";

  // Stable per-tab clientId
  const clientId = useMemo(() => {
    if (typeof window === "undefined") return "server";
    const existing = sessionStorage.getItem("clientId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("clientId", id);
    return id;
  }, []);

  // Basic UI state
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerNames, setPeerNames] = useState<Record<string, string>>({});
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [primaryRemoteId, setPrimaryRemoteId] = useState<string | null>(null);

  const [connected, setConnected] = useState(false);
  const [micOn, setMicOn] = useState(false); // start muted
  const [camOn, setCamOn] = useState(true);

  // Refs
  const channelRef = useRef<RealtimeChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, Peer>>(new Map());

  const remoteMainRef = useRef<HTMLVideoElement | null>(null);
  const localPipRef = useRef<HTMLVideoElement | null>(null);

  // ---- Helpers ----------------------------------------------

  const upsertPeerStream = (remoteId: string, stream: MediaStream) => {
    setPeerStreams((prev) => {
      if (prev[remoteId] === stream) return prev;
      return { ...prev, [remoteId]: stream };
    });
  };

  function getOrCreatePeer(remoteId: string, channel: RealtimeChannel) {
    let existing = peersRef.current.get(remoteId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });

    const remoteStream = new MediaStream();

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") setConnected(true);
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        setConnected(false);
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        channel.send({
          type: "broadcast",
          event: "webrtc",
          payload: {
            type: "ice",
            from: clientId,
            to: remoteId,
            candidate: e.candidate.toJSON(),
          },
        });
      }
    };

    pc.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        e.streams[0].getTracks().forEach((t) => {
          if (!remoteStream.getTracks().find((x) => x.id === t.id)) {
            remoteStream.addTrack(t);
          }
        });
      } else if (e.track) {
        if (!remoteStream.getTracks().find((x) => x.id === e.track.id)) {
          remoteStream.addTrack(e.track);
        }
      }
      upsertPeerStream(remoteId, remoteStream);
    };

    // Attach local tracks if we already have them
    if (localStreamRef.current) {
      localStreamRef.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStreamRef.current!));
    } else {
      // still receive even if we don't send
      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });
    }

    const peer: Peer = { pc, remoteStream };
    peersRef.current.set(remoteId, peer);
    return peer;
  }

  async function makeOffer(toId: string, channel: RealtimeChannel) {
    const { pc } = getOrCreatePeer(toId, channel);

    if (localStreamRef.current && pc.getSenders().length === 0) {
      localStreamRef.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStreamRef.current!));
    }

    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await pc.setLocalDescription(offer);

    channel.send({
      type: "broadcast",
      event: "webrtc",
      payload: { type: "offer", from: clientId, to: toId, sdp: offer },
    });
  }

  async function handleOffer(
    fromId: string,
    sdp: RTCSessionDescriptionInit,
    channel: RealtimeChannel
  ) {
    const { pc } = getOrCreatePeer(fromId, channel);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    if (localStreamRef.current && pc.getSenders().length === 0) {
      localStreamRef.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStreamRef.current!));
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    channel.send({
      type: "broadcast",
      event: "webrtc",
      payload: { type: "answer", from: clientId, to: fromId, sdp: answer },
    });
  }

  async function handleAnswer(
    fromId: string,
    sdp: RTCSessionDescriptionInit
  ) {
    const peer = peersRef.current.get(fromId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
  }

  async function handleIce(fromId: string, candidate: RTCIceCandidateInit) {
    const peer = peersRef.current.get(fromId);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {
      // ignore
    }
  }

  async function acquireLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });

    // start with mic muted
    stream.getAudioTracks().forEach((t) => {
      t.enabled = false;
    });

    localStreamRef.current = stream;
    return stream;
  }

  // ---- Load local name & room info --------------------------

  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("displayName");
      if (saved) setDisplayName(saved);
    }
  }, []);

  useEffect(() => {
    if (!roomId) return;
    const fetchRoom = async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("code")
        .eq("id", roomId)
        .maybeSingle();
      if (!error && data?.code) {
        setRoomCode(data.code);
      }
    };
    fetchRoom();
  }, [roomId]);

  // ---- Join room & wire realtime ----------------------------

  useEffect(() => {
    if (!roomId || !clientId) return;
    let isMounted = true;

    (async () => {
      try {
        await acquireLocalMedia();

        const channel = supabase.channel(`room:${roomId}`, {
          config: {
            broadcast: { self: false },
            presence: { key: clientId },
          },
        });

        // Signaling
        channel.on(
          "broadcast",
          { event: "webrtc" },
          async (message: { payload: WebRTCPayload }) => {
            const { payload } = message;
            const { type, from, to } = payload || {};
            if (!type || from === clientId) return;
            if (to && to !== clientId) return;

            if (type === "offer" && payload.sdp) {
              await handleOffer(from, payload.sdp, channel);
            } else if (type === "answer" && payload.sdp) {
              await handleAnswer(from, payload.sdp);
            } else if (type === "ice" && payload.candidate) {
              await handleIce(from, payload.candidate);
            }
          }
        );

        // Presence sync => who is in the room + their names
        channel.on("presence", { event: "sync" }, () => {
          const state = channel.presenceState() as Record<string, any[]>;
          const others: string[] = [];
          const names: Record<string, string> = {};

          Object.values(state).forEach((arr) => {
            arr.forEach((m: any) => {
              if (!m?.clientId) return;
              names[m.clientId] = m.displayName || "Partner";
              if (m.clientId !== clientId) {
                others.push(m.clientId);
              }
            });
          });

          setPeerIds(others);
          setPeerNames(names);

          // proactively offer to peers we don't yet have PCs for
          others.forEach((id) => {
            if (!peersRef.current.has(id)) {
              makeOffer(id, channel).catch(() => {});
            }
          });
        });

        // Subscribe, then track self
        await channel.subscribe(async (status: RealtimeSubscribeStatus) => {
          if (status === "SUBSCRIBED") {
            channel.track({ clientId, displayName });
          }
        });

        channelRef.current = channel;

        const cleanup = () => {
          try {
            if (channelRef.current) {
              channelRef.current.untrack();
              channelRef.current.unsubscribe();
              channelRef.current = null;
            }
          } catch {
            // ignore
          }
        };

        if (!isMounted) cleanup();
      } catch {
        // ignore
      }
    })();

    return () => {
      isMounted = false;

      // Close all peer connections
      peersRef.current.forEach(({ pc }) => {
        try {
          pc.close();
        } catch {}
      });
      peersRef.current.clear();

      // Stop local media
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      // Unsubscribe channel
      try {
        if (channelRef.current) {
          channelRef.current.untrack();
          channelRef.current.unsubscribe();
          channelRef.current = null;
        }
      } catch {
        // ignore
      }
    };
  }, [roomId, clientId, displayName]);

  // ---- Choose which remote to show as main ------------------

  useEffect(() => {
    if (peerIds.length === 0) {
      setPrimaryRemoteId(null);
    } else {
      setPrimaryRemoteId((prev) =>
        prev && peerIds.includes(prev) ? prev : peerIds[0]
      );
    }
  }, [peerIds]);

  // ---- Wire streams into main & PIP videos ------------------

  useEffect(() => {
    const mainEl = remoteMainRef.current;
    const pipEl = localPipRef.current;
    const localStream = localStreamRef.current;

    const mainStream =
      primaryRemoteId && peerStreams[primaryRemoteId]
        ? peerStreams[primaryRemoteId]
        : localStream;

    if (mainEl && mainStream) {
      if (mainEl.srcObject !== mainStream) {
        mainEl.srcObject = mainStream;
      }
      const isLocal = !primaryRemoteId;
      mainEl.muted = isLocal;
      mainEl.playsInline = true as any;
      mainEl.setAttribute("playsinline", "true");
      mainEl
        .play()
        .catch(() => {});
    }

    if (pipEl && localStream) {
      if (pipEl.srcObject !== localStream) {
        pipEl.srcObject = localStream;
      }
      pipEl.muted = true;
      pipEl.playsInline = true as any;
      pipEl.setAttribute("playsinline", "true");
      pipEl
        .play()
        .catch(() => {});
    }
  }, [primaryRemoteId, peerStreams]);

  // ---- Mic / Cam toggles ------------------------------------

  const handleToggleMic = () => {
    const next = !micOn;
    setMicOn(next);
    if (localStreamRef.current) {
      localStreamRef.current
        .getAudioTracks()
        .forEach((t) => (t.enabled = next));
    }
  };

  const handleToggleCam = () => {
    const next = !camOn;
    setCamOn(next);
    if (localStreamRef.current) {
      localStreamRef.current
        .getVideoTracks()
        .forEach((t) => (t.enabled = next));
    }
  };

  // ---- Render -----------------------------------------------

  const mainLabel =
    primaryRemoteId && peerNames[primaryRemoteId]
      ? peerNames[primaryRemoteId]
      : peerIds.length > 0
      ? "Partner"
      : displayName || "You";

  const selfLabel = displayName || "You";

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 flex flex-col">
      {/* Header row */}
      <header className="flex items-center justify-between px-4 py-3 bg-black">
        <div className="flex items-center gap-3">
          <span className="text-xs text-neutral-400">Room Code</span>
          <span className="inline-flex items-center rounded-full bg-neutral-800 px-3 py-1 text-xs font-mono tracking-[0.35em] text-neutral-100">
            {roomCode ?? "------"}
          </span>
        </div>

        <h1 className="text-base sm:text-lg font-semibold text-white">
          Any-Speak
        </h1>

        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              connected
                ? "bg-emerald-600/90 text-white"
                : "bg-red-900/80 text-red-100"
            }`}
          >
            {connected ? "Connected" : "Offline"}
          </span>

          <button
            onClick={handleToggleMic}
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              micOn
                ? "bg-neutral-200 text-neutral-900"
                : "bg-neutral-800 text-neutral-100"
            }`}
          >
            {micOn ? "Mic On" : "Mic Off"}
          </button>

          <button
            onClick={handleToggleCam}
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
              camOn
                ? "bg-neutral-200 text-neutral-900"
                : "bg-neutral-800 text-neutral-100"
            }`}
          >
            {camOn ? "Cam On" : "Cam Off"}
          </button>
        </div>
      </header>

      {/* Main video area */}
      <main className="flex-1 p-4">
        <div className="relative flex-1 min-h-[calc(100vh-120px)] rounded-2xl overflow-hidden bg-neutral-900 flex items-center justify-center">
          {/* Main video: partner if available, otherwise ourself */}
          <video
            ref={remoteMainRef}
            autoPlay
            playsInline
            className="max-h-full max-w-full object-contain"
          />
          <div className="absolute bottom-3 left-3 px-2 py-1 rounded bg-black/70 text-xs">
            {mainLabel}
          </div>

          {/* Self PIP */}
          <video
            ref={localPipRef}
            autoPlay
            muted
            playsInline
            className="pointer-events-none absolute bottom-4 right-4 h-24 w-32 rounded-xl border border-neutral-700/60 bg-black/70 object-cover shadow-lg shadow-black/60"
          />
          <div className="pointer-events-none absolute bottom-[0.9rem] right-5 px-1.5 py-0.5 rounded bg-black/70 text-[10px]">
            {selfLabel}
          </div>
        </div>
      </main>
    </div>
  );
}
