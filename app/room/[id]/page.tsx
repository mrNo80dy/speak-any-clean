"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// ---- Types ------------------------------------------------------------------

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
type PeerNames = Record<string, string>;

// ---- Small UI components ----------------------------------------------------

function Pill({
  children,
  active,
  tone,
  onClick,
}: {
  children: React.ReactNode;
  active?: boolean;
  tone: "status" | "neutral";
  onClick?: () => void;
}) {
  const base =
    "inline-flex items-center justify-center rounded-full px-4 py-1.5 text-sm font-medium transition-colors whitespace-nowrap";
  let classes = base;

  if (tone === "status") {
    classes += active
      ? " bg-emerald-700 text-emerald-50"
      : " bg-red-900 text-red-300";
  } else {
    classes += active
      ? " bg-emerald-700 text-emerald-50"
      : " bg-neutral-800 text-neutral-200";
  }

  if (onClick) classes += " cursor-pointer hover:brightness-110";

  return (
    <button type="button" onClick={onClick} className={classes}>
      {children}
    </button>
  );
}

// ---- Main component ---------------------------------------------------------

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  // Stable per-tab ID so reconnects in this tab look like same peer
  const clientId = useMemo(() => {
    if (typeof window === "undefined") return "server";
    const existing = sessionStorage.getItem("clientId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("clientId", id);
    return id;
  }, []);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const [roomCode, setRoomCode] = useState<string | null>(null);

  const [localDisplayName, setLocalDisplayName] = useState<string>("You");
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerNames, setPeerNames] = useState<PeerNames>({});
  const [connected, setConnected] = useState(false);

  // whose video is primary when there’s exactly one partner
  const [primaryId, setPrimaryId] = useState<"local" | string>("local");

  // local media state
  const [micOn, setMicOn] = useState(false); // default muted
  const [camOn, setCamOn] = useState(true);

  const [logs, setLogs] = useState<string[]>([]); // internal debug

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 200));
  };

  // ---------------------------------------------------------------------------
  // Refs
  // ---------------------------------------------------------------------------

  const channelRef = useRef<RealtimeChannel | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, Peer>>(new Map());

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function upsertPeerStream(remoteId: string, stream: MediaStream) {
    setPeerStreams((prev) => {
      if (prev[remoteId] === stream) return prev;
      return { ...prev, [remoteId]: stream };
    });
  }

  function getOrCreatePeer(remoteId: string, channel: RealtimeChannel) {
    let existing = peersRef.current.get(remoteId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
    });

    const remoteStream = new MediaStream();

    pc.onconnectionstatechange = () => {
      log(`pc(${remoteId}) state: ${pc.connectionState}`);
      if (pc.connectionState === "connected") {
        setConnected(true);
      }
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed"
      ) {
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
      log("ontrack", { from: remoteId, kind: e.track?.kind });
    };

    // add local tracks if we already have them
    if (localStreamRef.current) {
      localStreamRef.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStreamRef.current!));
    } else {
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

    log("sent offer", { to: toId });
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

    log("sent answer", { to: fromId });
  }

  async function handleAnswer(fromId: string, sdp: RTCSessionDescriptionInit) {
    const peer = peersRef.current.get(fromId);
    if (!peer) return;
    await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    log("applied answer", { from: fromId });
  }

  async function handleIce(fromId: string, candidate: RTCIceCandidateInit) {
    const peer = peersRef.current.get(fromId);
    if (!peer) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      log("added ice", { from: fromId });
    } catch (err) {
      log("ice error", { err: (err as Error).message });
    }
  }

  async function acquireLocalMedia() {
    if (localStreamRef.current) return localStreamRef.current;

    const constraints: MediaStreamConstraints = {
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;

    // default: camera on, mic OFF
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) audioTrack.enabled = false;
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.enabled = true;

    return stream;
  }

  // helper to attach local stream to any local video
  const attachLocalVideo = (el: HTMLVideoElement | null) => {
    if (!el) return;
    const stream = localStreamRef.current;
    if (!stream) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
      el.muted = true;
      // @ts-ignore
      el.playsInline = true;
      el.setAttribute("playsinline", "true");
      el.play().catch(() => {});
    }
  };

  // ---------------------------------------------------------------------------
  // Initial data: room code + display name
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!roomId) return;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("rooms")
          .select("code")
          .eq("id", roomId)
          .maybeSingle();
        if (!error && data?.code) setRoomCode(data.code);
      } catch {
        // non-fatal
      }
    })();
  }, [roomId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("displayName");
    if (saved && saved.trim()) setLocalDisplayName(saved.trim());
    else setLocalDisplayName("You");
  }, []);

  // ---------------------------------------------------------------------------
  // WebRTC + presence lifecycle
  // ---------------------------------------------------------------------------

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

        channel.on("presence", { event: "sync" }, () => {
          const state = channel.presenceState() as Record<string, any[]>;
          const entries = Object.values(state).flat() as any[];

          const others = entries.filter(
            (m) => m?.clientId && m.clientId !== clientId
          );

          const nextPeerIds = others.map((m) => m.clientId as string);
          const nextPeerNames: PeerNames = {};
          others.forEach((m) => {
            const id = m.clientId as string;
            const name: string =
              typeof m.displayName === "string" && m.displayName.trim()
                ? m.displayName.trim()
                : "Partner";
            nextPeerNames[id] = name;
          });

          setPeerIds(nextPeerIds);
          setPeerNames((prev) => ({ ...prev, ...nextPeerNames }));

          if (nextPeerIds.length === 0) {
            setPrimaryId("local");
            setConnected(false);
          } else if (nextPeerIds.length === 1) {
            setPrimaryId(nextPeerIds[0]);
            setConnected(true);
          } else {
            setPrimaryId(nextPeerIds[0]);
            setConnected(true);
          }

          nextPeerIds.forEach((id) => {
            if (!peersRef.current.has(id)) {
              makeOffer(id, channel).catch((e) =>
                log("offer error", { e: (e as Error).message })
              );
            }
          });
        });

        await channel.subscribe(async (status: RealtimeSubscribeStatus) => {
          if (status === "SUBSCRIBED") {
            log("subscribed to channel", { roomId, clientId });
            channel.track({ clientId, displayName: localDisplayName });
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
          } catch {}
        };

        if (!isMounted) cleanup();
      } catch (err) {
        log("init error", { err: (err as Error).message });
      }
    })();

    return () => {
      isMounted = false;

      peersRef.current.forEach(({ pc }) => {
        try {
          pc.close();
        } catch {}
      });
      peersRef.current.clear();

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }

      try {
        if (channelRef.current) {
          channelRef.current.untrack();
          channelRef.current.unsubscribe();
          channelRef.current = null;
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, clientId, localDisplayName]);

  // ---------------------------------------------------------------------------
  // Controls
  // ---------------------------------------------------------------------------

  const handleToggleMic = () => {
    setMicOn((prev) => {
      const next = !prev;
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (track) track.enabled = next;
      return next;
    });
  };

  const handleToggleCam = () => {
    setCamOn((prev) => {
      const next = !prev;
      const track = localStreamRef.current?.getVideoTracks()[0];
      if (track) track.enabled = next;
      return next;
    });
  };

  // ---------------------------------------------------------------------------
  // Layout helpers
  // ---------------------------------------------------------------------------

  const remoteIds = peerIds;
  const showPipLayout = remoteIds.length === 1;
  const showGridLayout = remoteIds.length >= 2;

  const primaryRemoteId =
    (showPipLayout || showGridLayout) && remoteIds.length > 0
      ? primaryId !== "local"
        ? primaryId
        : remoteIds[0]
      : null;

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 flex flex-col">
      {/* Header */}
      <header className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900">
        <div className="flex items-center gap-2 min-w-[120px]">
          <span className="text-sm text-neutral-400">Room Code</span>
          <span className="inline-flex items-center rounded-full bg-neutral-800 px-3 py-1 text-xs font-mono tracking-[0.35em] text-neutral-100">
            {roomCode ?? "------"}
          </span>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <h1 className="text-xl font-semibold tracking-wide">Any-Speak</h1>
        </div>

        <div className="flex items-center justify-end gap-2 min-w-[220px]">
          <Pill tone="status" active={connected}>
            {connected ? "Connected" : "Offline"}
          </Pill>
          <Pill tone="neutral" active={micOn} onClick={handleToggleMic}>
            {micOn ? "Mic On" : "Mic Off"}
          </Pill>
          <Pill tone="neutral" active={camOn} onClick={handleToggleCam}>
            {camOn ? "Cam On" : "Cam Off"}
          </Pill>
        </div>
      </header>

      {/* Main video area */}
      <div className="flex-1 w-full p-4 flex flex-col min-h-0">
        {/* 0 peers: just show yourself full screen */}
        {remoteIds.length === 0 && (
          <div className="relative flex-1 min-h-0 rounded-2xl overflow-hidden bg-neutral-900">
            <video
              ref={attachLocalVideo}
              autoPlay
              playsInline
              className="h-full w-full object-contain"
            />
            <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded">
              {localDisplayName}
            </div>
          </div>
        )}

        {/* 1 peer: remote big, you as PIP */}
        {showPipLayout && primaryRemoteId && (
          <div className="relative flex-1 min-h-0 rounded-2xl overflow-hidden bg-neutral-900">
            {/* main remote */}
            <video
              autoPlay
              playsInline
              className="h-full w-full object-contain"
              ref={(el) => {
                if (!el) return;
                const stream = peerStreams[primaryRemoteId];
                if (stream && el.srcObject !== stream) {
                  el.srcObject = stream;
                  // @ts-ignore
                  el.playsInline = true;
                  el.setAttribute("playsinline", "true");
                  el.play().catch(() => {});
                }
              }}
            />
            <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded">
              {peerNames[primaryRemoteId] ?? "Partner"}
            </div>

            {/* local PIP */}
            <div className="absolute bottom-4 right-4 w-40 h-24 rounded-xl overflow-hidden border border-neutral-800 bg-neutral-900/70">
              <video
                ref={attachLocalVideo}
                autoPlay
                playsInline
                className="h-full w-full object-contain"
              />
              <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded">
                {localDisplayName}
              </div>
            </div>
          </div>
        )}

        {/* 2+ peers: simple grid */}
        {showGridLayout && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 flex-1 min-h-0">
            {/* local tile */}
            <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
              <video
                ref={attachLocalVideo}
                autoPlay
                playsInline
                className="h-full w-full object-contain"
              />
              <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded">
                {localDisplayName}
              </div>
            </div>

            {/* remote tiles */}
            {remoteIds.map((id) => {
              const stream = peerStreams[id];
              return (
                <div
                  key={id}
                  className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video"
                >
                  <video
                    autoPlay
                    playsInline
                    className="h-full w-full object-contain"
                    ref={(el) => {
                      if (!el) return;
                      if (stream && el.srcObject !== stream) {
                        el.srcObject = stream;
                        // @ts-ignore
                        el.playsInline = true;
                        el.setAttribute("playsinline", "true");
                        el.play().catch(() => {});
                      }
                    }}
                  />
                  <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded">
                    {peerNames[id] ?? "Partner"}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
