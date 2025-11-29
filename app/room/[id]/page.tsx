"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Types
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

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  // Stable per-tab clientId
  const clientId = useMemo(() => {
    if (typeof window === "undefined") return "server";
    const existing = sessionStorage.getItem("clientId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("clientId", id);
    return id;
  }, []);

  // ---- Refs / state -----------------------------------------
  const channelRef = useRef<RealtimeChannel | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // Room metadata (for header)
  const [roomCode, setRoomCode] = useState<string | null>(null);
  // (roomName is easy to add later if we want)

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 200));
  };

  // ---- Fetch real room code from Supabase -------------------
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("name, code")
        .eq("id", roomId)
        .maybeSingle();

      if (error) {
        console.error("Failed to load room metadata", error);
        return;
      }

      if (!cancelled) {
        setRoomCode(data?.code ?? null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // ---- Helpers ----------------------------------------------
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
      if (pc.connectionState === "connected") setConnected(true);
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
      // Merge incoming tracks into our stable stream
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

    // Add local tracks if we already have them
    if (localStreamRef.current) {
      localStreamRef.current
        .getTracks()
        .forEach((t) => pc.addTrack(t, localStreamRef.current!));
    } else {
      // Ensure we still receive even if local is missing
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

    // Ensure local tracks exist
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

  async function handleAnswer(
    fromId: string,
    sdp: RTCSessionDescriptionInit
  ) {
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

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = stream;
      // local preview must be muted to avoid feedback
      localVideoRef.current.muted = true;
      await localVideoRef.current.play().catch(() => {});
    }
    return stream;
  }

  // Attach remote streams to hidden <audio> elements to force autoplay
  useEffect(() => {
    const tryPlayAll = async () => {
      const audios =
        document.querySelectorAll<HTMLAudioElement>("audio[data-remote]");
      for (const a of Array.from(audios)) {
        try {
          await a.play();
        } catch {
          setNeedsUnmute(true);
        }
      }
    };
    tryPlayAll();
  }, [peerStreams]);

  // ---- Lifecycle: join room, wire realtime -------------------
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

        // Broadcast signaling
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

        // Presence sync -> know who to call
        channel.on("presence", { event: "sync" }, () => {
          const state = channel.presenceState() as Record<string, any[]>;
          const others: string[] = Object.values(state)
            .flat()
            .map((m: any) => m?.clientId)
            .filter((id: string) => id && id !== clientId);

          setPeerIds(others);

          // Proactively offer to peers we don't yet have a PC for
          others.forEach((id) => {
            if (!peersRef.current.has(id)) {
              makeOffer(id, channel).catch((e) =>
                log("offer error", { e: (e as Error).message })
              );
            }
          });
        });

        // Subscribe, then track presence
        await channel.subscribe(async (status: RealtimeSubscribeStatus) => {
          if (status === "SUBSCRIBED") {
            log("subscribed to channel", { roomId, clientId });
            channel.track({ clientId });
          }
        });

        channelRef.current = channel;

        // Cleanup on unmount
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

      // Close PCs
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
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, clientId]);

  // ---- UI controls ------------------------------------------
  const handleUnmuteClick = async () => {
    setNeedsUnmute(false);
    const audios =
      document.querySelectorAll<HTMLAudioElement>("audio[data-remote]");
    for (const a of Array.from(audios)) {
      try {
        await a.play();
      } catch {}
    }
  };

  const toggleCamera = async () => {
    if (!localStreamRef.current) return;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.enabled = !videoTrack.enabled;
  };

  const toggleMic = async () => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
  };

  // Layout helpers for PIP
  const primaryPeerId = peerIds[0] ?? null;
  const secondaryPeerIds = primaryPeerId ? peerIds.slice(1) : [];

  // ---- Render -----------------------------------------------
  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-6xl p-4 space-y-4">
        {/* Header - mobile friendly, centered title */}
        <header className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-2 py-3">
          {/* LEFT: room code pill */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-400">Code</span>
            <span className="inline-flex items-center rounded-full bg-neutral-800 px-3 py-1 text-xs font-mono tracking-[0.35em] text-neutral-100">
              {roomCode ?? "------"}
            </span>
          </div>

          {/* CENTER: app title */}
          <h1 className="text-2xl font-semibold tracking-tight text-center">
            Any-Speak
          </h1>

          {/* RIGHT: connection status + controls */}
          <div className="flex items-center justify-end gap-2">
            <span
              className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ${
                connected
                  ? "bg-emerald-600/20 text-emerald-300"
                  : "bg-red-600/20 text-red-300"
              }`}
            >
              {connected ? "Connected" : "Offline"}
            </span>

            <button
              onClick={toggleMic}
              className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm"
            >
              Toggle Mic
            </button>
            <button
              onClick={toggleCamera}
              className="px-3 py-1.5 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm"
            >
              Toggle Cam
            </button>
          </div>
        </header>

        {needsUnmute && (
          <div className="p-3 rounded-xl bg-amber-900/30 border border-amber-500/30">
            <p className="text-sm">
              Your browser blocked autoplay with sound. Click below to start
              remote audio.
            </p>
            <button
              onClick={handleUnmuteClick}
              className="mt-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-sm"
            >
              Unmute Remote Audio
            </button>
          </div>
        )}

        {/* MAIN VIDEO + THUMBNAILS (PIP-style) */}
        <div className="flex flex-col gap-3">
          {/* Primary view:
              - If there is a peer: show them full-screen, local self in PIP.
              - Otherwise: show local self full-screen. */}
          <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
            {primaryPeerId ? (
              <>
                {/* Remote as main */}
                <video
                  autoPlay
                  playsInline
                  className="h-full w-full object-cover"
                  ref={(el) => {
                    const stream = peerStreams[primaryPeerId];
                    if (el && stream && el.srcObject !== stream) {
                      el.srcObject = stream;
                    }
                  }}
                />
                {/* Audio for primary peer */}
                <audio
                  data-remote
                  autoPlay
                  ref={(el) => {
                    const stream = peerStreams[primaryPeerId];
                    if (el && stream && el.srcObject !== stream) {
                      el.srcObject = stream;
                    }
                  }}
                />
                {/* Local PIP */}
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  className="absolute bottom-3 right-3 h-24 w-24 rounded-xl border border-neutral-700 bg-black/60 object-cover"
                />
                <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                  {primaryPeerId.slice(0, 8)}
                </div>
              </>
            ) : (
              <>
                {/* Only me in the room */}
                <video
                  ref={localVideoRef}
                  autoPlay
                  playsInline
                  className="h-full w-full object-cover"
                />
                <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                  You
                </div>
              </>
            )}
          </div>

          {/* Additional participants as scrollable thumbnails */}
          {secondaryPeerIds.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {secondaryPeerIds.map((pid) => (
                <div
                  key={pid}
                  className="relative h-24 w-40 flex-shrink-0 rounded-xl overflow-hidden bg-neutral-900"
                >
                  <video
                    autoPlay
                    playsInline
                    className="h-full w-full object-cover"
                    ref={(el) => {
                      const stream = peerStreams[pid];
                      if (el && stream && el.srcObject !== stream) {
                        el.srcObject = stream;
                      }
                    }}
                  />
                  <audio
                    data-remote
                    autoPlay
                    ref={(el) => {
                      const stream = peerStreams[pid];
                      if (el && stream && el.srcObject !== stream) {
                        el.srcObject = stream;
                      }
                    }}
                  />
                  <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded">
                    {pid.slice(0, 8)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* NOTE: debug logs no longer rendered in the UI.
           We still keep `logs` & `log()` for future dev, but nothing is shown. */}
      </div>
    </div>
  );
}
