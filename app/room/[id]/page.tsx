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

type RoomInfo = {
  code: string | null;
};

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
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]); // kept for debugging, not rendered
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");

  const [micOn, setMicOn] = useState(false); // default muted
  const [camOn, setCamOn] = useState(true);

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 200));
  };

  // helper: whenever a local <video> mounts, attach the current stream
  const attachLocalVideoRef = (el: HTMLVideoElement | null) => {
    localVideoRef.current = el;
    const stream = localStreamRef.current;
    if (el && stream && el.srcObject !== stream) {
      el.srcObject = stream;
      el.muted = true;
      el.playsInline = true as any;
      el.setAttribute("playsinline", "true");
      el.play().catch(() => {});
    }
  };

  // ---- Load display name from localStorage -------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("displayName");
    if (saved) setDisplayName(saved);
  }, []);

  // ---- Load room code from Supabase --------------------------
  useEffect(() => {
    if (!roomId) return;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("rooms")
          .select("code")
          .eq("id", roomId)
          .maybeSingle();

        if (error) {
          log("room load error", { message: error.message });
          return;
        }

        if (data) {
          setRoomInfo({
            code: data.code ?? null,
          });
        }
      } catch (err) {
        log("room load error", { err: (err as Error).message });
      }
    })();
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
      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        // if all peers gone, mark disconnected
        setTimeout(() => {
          if (peersRef.current.size === 0) setConnected(false);
        }, 0);
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

    // Add local tracks if we already have them
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

    // default: mic muted, camera on
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = false;
      setMicOn(false);
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      setCamOn(videoTrack.enabled);
    }

    if (localVideoRef.current) {
      attachLocalVideoRef(localVideoRef.current);
    }

    return stream;
  }

  // Attach remote streams to hidden <audio> to force autoplay
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

        // Presence sync -> who to call + names
        channel.on("presence", { event: "sync" }, () => {
          const state = channel.presenceState() as Record<string, any[]>;
          const others: string[] = [];
          const labels: Record<string, string> = {};

          Object.values(state).forEach((arr) => {
            arr.forEach((m: any) => {
              if (!m?.clientId) return;
              if (m.clientId === clientId) return;
              others.push(m.clientId);
              labels[m.clientId] =
                (m.name as string | undefined) ||
                m.clientId.slice(0, 8) ||
                "Guest";
            });
          });

          setPeerIds(others);
          setPeerLabels(labels);

          others.forEach((id) => {
            if (!peersRef.current.has(id)) {
              makeOffer(id, channel).catch((e) =>
                log("offer error", { e: (e as Error).message })
              );
            }
          });
        });

        // Subscribe, then track presence (include name)
        await channel.subscribe(async (status: RealtimeSubscribeStatus) => {
          if (status === "SUBSCRIBED") {
            log("subscribed to channel", { roomId, clientId });
            channel.track({ clientId, name: displayName });
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
  }, [roomId, clientId, displayName]);

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
    const next = !videoTrack.enabled;
    videoTrack.enabled = next;
    setCamOn(next);
  };

  const toggleMic = async () => {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (!audioTrack) return;
    const next = !audioTrack.enabled;
    audioTrack.enabled = next;
    setMicOn(next);
  };

  const firstRemoteId = peerIds[0] ?? null;
  const firstRemoteStream = firstRemoteId ? peerStreams[firstRemoteId] : null;

  // pill helpers
  const pillBase =
    "inline-flex items-center justify-center px-4 py-1 rounded-full text-xs md:text-sm font-medium border transition-colors";

  const connectedClass = connected
    ? "bg-emerald-600/90 text-white border-emerald-500"
    : "bg-red-900/70 text-red-200 border-red-700";

  const micClass = micOn
    ? "bg-neutral-800 text-neutral-50 border-neutral-600"
    : "bg-red-900/80 text-red-100 border-red-700";

  const camClass = camOn
    ? "bg-neutral-100 text-neutral-900 border-neutral-300"
    : "bg-red-900/80 text-red-100 border-red-700";

  // ---- Render -----------------------------------------------
  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100 pb-20 md:pb-8">
      <div className="mx-auto max-w-6xl p-3 md:p-4 space-y-4">
        {/* Top bar */}
        <header className="flex items-center justify-between gap-2 flex-wrap">
          {/* Left: room code */}
          <div className="flex items-center gap-2">
            {roomInfo?.code && (
              <>
                <span className="text-xs text-neutral-400">Room Code</span>
                <span className="px-3 py-1 rounded-full bg-neutral-900 border border-neutral-700 font-mono tracking-[0.25em] text-xs md:text-sm">
                  {roomInfo.code}
                </span>
              </>
            )}
          </div>

          {/* Center: title */}
          <div className="flex-1 text-center order-first md:order-none">
            <h1 className="text-lg md:text-xl font-semibold">Any-Speak</h1>
          </div>

          {/* Right: status + toggles */}
          <div className="flex items-center gap-2">
            <span className={`${pillBase} ${connectedClass}`}>
              {connected ? "Connected" : "Offline"}
            </span>
            <button onClick={toggleMic} className={`${pillBase} ${micClass}`}>
              {micOn ? "Mic On" : "Mic Off"}
            </button>
            <button
              onClick={toggleCamera}
              className={`${pillBase} ${camClass}`}
            >
              {camOn ? "Cam On" : "Cam Off"}
            </button>
          </div>
        </header>

        {needsUnmute && (
          <div className="p-3 rounded-xl bg-amber-900/30 border border-amber-500/30">
            <p className="text-sm">
              Your browser blocked autoplay with sound. Tap below to start
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

        {/* Video Layouts */}
        {peerIds.length === 0 && (
          // Only you in the room: big self view
          <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
            <video
              ref={attachLocalVideoRef}
              autoPlay
              playsInline
              className="h-full w-full object-cover"
            />
            <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
              You
            </div>
          </div>
        )}

        {peerIds.length === 1 && firstRemoteId && (
          // 1:1 call: remote big, you small (picture-in-picture)
          <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
            {/* Remote big */}
            <video
              autoPlay
              playsInline
              className="h-full w-full object-cover"
              ref={(el) => {
                if (
                  el &&
                  firstRemoteStream &&
                  el.srcObject !== firstRemoteStream
                ) {
                  el.srcObject = firstRemoteStream;
                }
              }}
            />
            <audio
              data-remote
              autoPlay
              ref={(el) => {
                if (
                  el &&
                  firstRemoteStream &&
                  el.srcObject !== firstRemoteStream
                ) {
                  el.srcObject = firstRemoteStream;
                }
              }}
            />
            <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
              {peerLabels[firstRemoteId] ?? firstRemoteId.slice(0, 8)}
            </div>

            {/* Local PiP */}
            <div className="absolute bottom-3 right-3 w-32 h-20 md:w-40 md:h-24 rounded-xl overflow-hidden border border-neutral-700 bg-black/70">
              <video
                ref={attachLocalVideoRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
              <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded">
                You
              </div>
            </div>
          </div>
        )}

        {peerIds.length > 1 && (
          // 3+ participants: simple grid for now
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Local self-view */}
            <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
              <video
                ref={attachLocalVideoRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
              <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                You
              </div>
            </div>

            {/* Remote tiles */}
            {peerIds.map((pid) => (
              <div
                key={pid}
                className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video"
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
                <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                  {peerLabels[pid] ?? pid.slice(0, 8)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
