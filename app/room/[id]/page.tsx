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

  // local media
  const localMainRef = useRef<HTMLVideoElement | null>(null);
  const localPipRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const [hasLocalStream, setHasLocalStream] = useState(false);

  // peers
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});

  // UI state
  const [needsUnmute, setNeedsUnmute] = useState(false);
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // Room metadata (for header)
  const [roomCode, setRoomCode] = useState<string | null>(null);

  // Local display name (“Chad”, “Chad’s phone”, etc)
  const [displayName, setDisplayName] = useState<string>("You");

  // Mic / cam state (mic starts muted)
  const [micEnabled, setMicEnabled] = useState<boolean>(false);
  const [camEnabled, setCamEnabled] = useState<boolean>(true);

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 200));
  };

  // ---- Load display name from localStorage ------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("displayName");
    if (saved) setDisplayName(saved);
  }, []);

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

    // Apply initial mic/cam state (mic muted by default)
    stream.getAudioTracks().forEach((t) => {
      t.enabled = micEnabled;
    });
    stream.getVideoTracks().forEach((t) => {
      t.enabled = camEnabled;
    });

    setHasLocalStream(true);
    return stream;
  }

  // Attach local stream to whichever video elements exist
  useEffect(() => {
    if (!hasLocalStream || !localStreamRef.current) return;

    const els: HTMLVideoElement[] = [];
    if (localMainRef.current) els.push(localMainRef.current);
    if (localPipRef.current) els.push(localPipRef.current);

    for (const el of els) {
      if (!el) continue;
      if (el.srcObject !== localStreamRef.current) {
        el.srcObject = localStreamRef.current;
      }
      el.muted = true;
      el.playsInline = true as any;
      el.setAttribute("playsinline", "true");
      el
        .play()
        .catch(() => {
          /* ignore */
        });
    }
  }, [hasLocalStream]);

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

  const toggleCamera = () => {
    setCamEnabled((prev) => {
      const next = !prev;
      if (localStreamRef.current) {
        localStreamRef.current
          .getVideoTracks()
          .forEach((t) => (t.enabled = next));
      }
      return next;
    });
  };

  const toggleMic = () => {
    setMicEnabled((prev) => {
      const next = !prev;
      if (localStreamRef.current) {
        localStreamRef.current
          .getAudioTracks()
          .forEach((t) => (t.enabled = next));
      }
      return next;
    });
  };

  // Layout helpers
  const totalParticipants = 1 + peerIds.length;
  const primaryPeerId = peerIds[0] ?? null;
  const secondaryPeerIds = primaryPeerId ? peerIds.slice(1) : [];

  // ---- Render -----------------------------------------------
  return (
    <div className="min-h-screen w-full bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-6xl p-4 space-y-4">
        {/* Header: single logical row, flex-wrap for small screens */}
        <header className="flex flex-wrap items-center gap-3 px-2 py-3">
          {/* LEFT: room code pill */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-400">Code</span>
            <span className="inline-flex items-center rounded-full bg-neutral-800 px-3 py-1 text-xs font-mono tracking-[0.35em] text-neutral-100">
              {roomCode ?? "------"}
            </span>
          </div>

          {/* CENTER: app title */}
          <div className="flex-1 text-center">
            <h1 className="text-2xl font-semibold tracking-tight">
              Any-Speak
            </h1>
          </div>

          {/* RIGHT: connection status + controls */}
          <div className="flex items-center gap-2 ml-auto">
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
              className={`px-3 py-1.5 rounded-xl text-sm transition-colors ${
                micEnabled
                  ? "bg-emerald-600 text-white hover:bg-emerald-500"
                  : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
              }`}
            >
              {micEnabled ? "Mic On" : "Mic Off"}
            </button>
            <button
              onClick={toggleCamera}
              className={`px-3 py-1.5 rounded-xl text-sm transition-colors ${
                camEnabled
                  ? "bg-neutral-200 text-neutral-900 hover:bg-neutral-300"
                  : "bg-neutral-800 text-neutral-100 hover:bg-neutral-700"
              }`}
            >
              {camEnabled ? "Cam On" : "Cam Off"}
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

        {/* MAIN VIDEO AREA: different layouts depending on participant count */}
        <div className="flex flex-col gap-3">
          {totalParticipants === 1 && (
            // Only me in the room
            <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
              <video
                ref={localMainRef}
                autoPlay
                playsInline
                className="h-full w-full object-cover"
              />
              <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                {displayName}
              </div>
            </div>
          )}

          {totalParticipants === 2 && (
            // PIP layout: remote full, local small
            <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
              {/* Remote main */}
              {primaryPeerId && (
                <>
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
                  <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                    Partner
                  </div>
                </>
              )}

              {/* Local PIP */}
              <video
                ref={localPipRef}
                autoPlay
                playsInline
                className="absolute bottom-3 right-3 h-24 w-24 rounded-xl border border-neutral-700 bg-black/60 object-cover"
              />
              <div className="absolute bottom-4 right-4 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded">
                {displayName}
              </div>
            </div>
          )}

          {totalParticipants >= 3 && totalParticipants <= 4 && (
            // Grid layout: everyone visible (up to 4)
            <div className="grid grid-cols-2 gap-2 rounded-2xl bg-neutral-900 p-2">
              {/* Local tile */}
              <div className="relative rounded-xl overflow-hidden bg-black aspect-video">
                <video
                  ref={localMainRef}
                  autoPlay
                  playsInline
                  className="h-full w-full object-cover"
                />
                <div className="absolute bottom-1 left-1 text-xs bg-neutral-900/70 px-1.5 py-0.5 rounded">
                  {displayName}
                </div>
              </div>

              {/* Peer tiles */}
              {peerIds.slice(0, 3).map((pid) => (
                <div
                  key={pid}
                  className="relative rounded-xl overflow-hidden bg-black aspect-video"
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
                    Guest
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalParticipants > 4 && (
            <>
              {/* Primary view same as 2-person PIP */}
              <div className="relative rounded-2xl overflow-hidden bg-neutral-900 aspect-video">
                {primaryPeerId && (
                  <>
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
                    <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/60 px-2 py-1 rounded">
                      Speaker
                    </div>
                  </>
                )}

                <video
                  ref={localPipRef}
                  autoPlay
                  playsInline
                  className="absolute bottom-3 right-3 h-24 w-24 rounded-xl border border-neutral-700 bg-black/60 object-cover"
                />
                <div className="absolute bottom-4 right-4 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded">
                  {displayName}
                </div>
              </div>

              {/* Scrollable strip of other participants */}
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
                      Guest
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Debug logs are kept in state (for dev) but not rendered now. */}
      </div>
    </div>
  );
}
