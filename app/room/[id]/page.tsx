"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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

type TranscriptPayload = {
  from: string;
  text: string;
  lang: string;
  name?: string; // speaker name, sent with each transcript
};

type Peer = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
};

type PeerStreams = Record<string, MediaStream>;

type RoomInfo = {
  code: string | null;
};

type ChatMessage = {
  id: string;
  fromId: string;
  fromName: string;
  originalLang: string;
  translatedLang: string;
  originalText: string;
  translatedText: string;
  isLocal: boolean;
  at: number;
};

type SttStatus = "unknown" | "ok" | "unsupported" | "error";

/**
 * Front-end helper: call our /api/translate route.
 * Each device can ask for its own target language.
 */
async function translateText(
  fromLang: string,
  toLang: string,
  text: string
): Promise<{ translatedText: string; targetLang: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { translatedText: "", targetLang: toLang };

  // If languages match, skip the API call but still show the right arrow
  if (fromLang === toLang) return { translatedText: trimmed, targetLang: toLang };

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, fromLang, toLang }),
    });

    if (!res.ok) {
      console.warn("[translateText] /api/translate not ok", res.status);
      return { translatedText: trimmed, targetLang: toLang };
    }

    const data = (await res.json()) as { translatedText?: string; error?: string };
    const maybe = (data.translatedText ?? "").trim();
    const translated = maybe.length > 0 && !data.error ? maybe : trimmed;

    return { translatedText: translated, targetLang: toLang };
  } catch (err) {
    console.error("[translateText] error", err);
    return { translatedText: trimmed, targetLang: toLang };
  }
}

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  // Debug mode: show language controls ONLY if URL has ?debug=1
  const [debugMode, setDebugMode] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    setDebugMode(sp.get("debug") === "1");
  }, []);

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
  const peerLabelsRef = useRef<Record<string, string>>({});
  const recognitionRef = useRef<any>(null);
  const micOnRef = useRef(false);

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

  // For 5+ participants: which participant is shown large
  // "local" means your own camera; otherwise a peerId.
  const [spotlightId, setSpotlightId] = useState<string>("local");

  // Captions / text stream
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showCaptions, setShowCaptions] = useState(false);
  const [captionLines, setCaptionLines] = useState<number>(3);

  // Debug: override speak/read languages
  const deviceLang =
    (typeof navigator !== "undefined" && navigator.language) || "en-US";

  const [debugSpeakLang, setDebugSpeakLang] = useState<string>(""); // "" = auto
  const [debugReadLang, setDebugReadLang] = useState<string>(""); // "" = auto

  const speakLangRef = useRef<string>(deviceLang);
  const readLangRef = useRef<string>(deviceLang);

  // Hand raise
  const [handsUp, setHandsUp] = useState<Record<string, boolean>>({});
  const [myHandUp, setMyHandUp] = useState(false);

  // STT status
  const [sttStatus, setSttStatus] = useState<SttStatus>("unknown");
  const [sttErrorMessage, setSttErrorMessage] = useState<string | null>(null);

  // Manual text captions
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");

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

  function pushMessage(msg: Omit<ChatMessage, "id" | "at">) {
    const full: ChatMessage = {
      ...msg,
      id: crypto.randomUUID(),
      at: Date.now(),
    };
    setMessages((prev) => [...prev.slice(-29), full]); // keep last 30
  }

  // keep micOn in a ref so STT onend can see latest
  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  // keep debug language overrides in refs for STT + transcript handler
  useEffect(() => {
    const speak = debugMode && debugSpeakLang ? debugSpeakLang : deviceLang;
    const read = debugMode && debugReadLang ? debugReadLang : deviceLang;
    speakLangRef.current = speak;
    readLangRef.current = read;
  }, [debugMode, debugSpeakLang, debugReadLang, deviceLang]);

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

        if (data) setRoomInfo({ code: data.code ?? null });
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
          if (!remoteStream.getTracks().find((x) => x.id === t.id)) remoteStream.addTrack(t);
        });
      } else if (e.track) {
        if (!remoteStream.getTracks().find((x) => x.id === e.track.id)) remoteStream.addTrack(e.track);
      }
      upsertPeerStream(remoteId, remoteStream);
      log("ontrack", { from: remoteId, kind: e.track?.kind });
    };

    // Add local tracks if we already have them
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
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
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);

    channel.send({
      type: "broadcast",
      event: "webrtc",
      payload: { type: "offer", from: clientId, to: toId, sdp: offer },
    });

    log("sent offer", { to: toId });
  }

  async function handleOffer(fromId: string, sdp: RTCSessionDescriptionInit, channel: RealtimeChannel) {
    const { pc } = getOrCreatePeer(fromId, channel);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    if (localStreamRef.current && pc.getSenders().length === 0) {
      localStreamRef.current.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
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

    // default: mic muted, camera on
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = false;
      setMicOn(false);
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) setCamOn(videoTrack.enabled);

    if (localVideoRef.current) attachLocalVideoRef(localVideoRef.current);

    return stream;
  }

  // ---- STT setup: Web Speech API -----------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as any;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      log("speech recognition not supported");
      setSttStatus("unsupported");
      setSttErrorMessage("Device browser does not support live captions.");
      return;
    }

    const rec = new SpeechRecognitionCtor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = speakLangRef.current || deviceLang;

    rec.onstart = () => {
      setSttStatus("ok");
      setSttErrorMessage(null);
    };

    rec.onresult = async (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;
      const last = results[results.length - 1];
      if (!last.isFinal) return;

      const raw = last[0]?.transcript || "";
      const text = raw.trim();
      if (!text) return;

      // IMPORTANT: Speak lang is the language STT is listening as
      const lang = rec.lang || (speakLangRef.current || deviceLang);
      const fromName = displayName || "You";

      // Translate into whatever this device wants to READ (auto) or debug override
      const target = readLangRef.current || deviceLang;
      const { translatedText, targetLang } = await translateText(lang, target, text);

      pushMessage({
        fromId: clientId,
        fromName,
        originalLang: lang,
        translatedLang: targetLang,
        originalText: text,
        translatedText,
        isLocal: true,
      });

      if (channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "transcript",
          payload: { from: clientId, text, lang, name: fromName },
        });
      }
    };

    rec.onerror = (event: any) => {
      log("stt error", { error: event.error });
      setSttStatus("error");
      setSttErrorMessage(event.error || "Speech recognition error.");

      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        try {
          rec.stop();
        } catch {}
      }
    };

    rec.onend = () => {
      // Browser stops occasionally; restart if mic is still on *and* no hard error
      if (micOnRef.current && sttStatus !== "unsupported") {
        try {
          rec.start();
        } catch {}
      }
    };

    recognitionRef.current = rec;

    return () => {
      try {
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, debugMode, debugSpeakLang, deviceLang, sttStatus]);

  // Start/stop STT when mic toggles
  useEffect(() => {
    const rec = recognitionRef.current;
    if (!rec) return;

    if (micOn && sttStatus !== "unsupported") {
      try {
        rec.start();
      } catch {}
    } else {
      try {
        rec.stop();
      } catch {}
    }
  }, [micOn, sttStatus]);

  // Attach remote streams to hidden <audio> to force autoplay
  useEffect(() => {
    const tryPlayAll = async () => {
      const audios = document.querySelectorAll<HTMLAudioElement>("audio[data-remote]");
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
        channel.on("broadcast", { event: "webrtc" }, async (message: { payload: WebRTCPayload }) => {
          const { payload } = message;
          const { type, from, to } = payload || {};
          if (!type || from === clientId) return;
          if (to && to !== clientId) return;

          if (type === "offer" && payload.sdp) await handleOffer(from, payload.sdp, channel);
          else if (type === "answer" && payload.sdp) await handleAnswer(from, payload.sdp);
          else if (type === "ice" && payload.candidate) await handleIce(from, payload.candidate);
        });

        // Broadcast: transcripts (captions)
        channel.on(
          "broadcast",
          { event: "transcript" },
          async (message: { payload: TranscriptPayload }) => {
            const { payload } = message;
            if (!payload) return;
            const { from, text, lang, name } = payload;
            if (!text || !from || from === clientId) return;

            const fromName =
              name ?? peerLabelsRef.current[from] ?? from.slice(0, 8) ?? "Guest";

            // Translate into this device's reading language (auto) or debug override
            const target = readLangRef.current || deviceLang;
            const { translatedText, targetLang: outLang } = await translateText(lang, target, text);

            pushMessage({
              fromId: from,
              fromName,
              originalLang: lang,
              translatedLang: outLang,
              originalText: text,
              translatedText,
              isLocal: false,
            });
          }
        );

        // Broadcast: hand raise signals
        channel.on(
          "broadcast",
          { event: "hand" },
          (message: { payload: { from: string; up: boolean } }) => {
            const { payload } = message;
            if (!payload) return;
            const { from, up } = payload;
            if (!from || from === clientId) return;

            setHandsUp((prev) => ({ ...prev, [from]: up }));
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
                (m.name as string | undefined) || m.clientId.slice(0, 8) || "Guest";
            });
          });

          setPeerIds(others);
          setPeerLabels(labels);
          peerLabelsRef.current = labels;

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
    const audios = document.querySelectorAll<HTMLAudioElement>("audio[data-remote]");
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

  const toggleHand = () => {
    const next = !myHandUp;
    setMyHandUp(next);
    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "hand",
        payload: { from: clientId, up: next },
      });
    }
  };

  // Manual text caption submit
  const handleTextSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = textInput.trim();
    if (!text) return;

    const lang = speakLangRef.current || deviceLang; // assume same as "speak" language
    const fromName = displayName || "You";

    const target = readLangRef.current || deviceLang;
    const { translatedText, targetLang: outLang } = await translateText(lang, target, text);

    pushMessage({
      fromId: clientId,
      fromName,
      originalLang: lang,
      translatedLang: outLang,
      originalText: text,
      translatedText,
      isLocal: true,
    });

    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "transcript",
        payload: { from: clientId, text, lang, name: fromName },
      });
    }

    setTextInput("");
  };

  const firstRemoteId = peerIds[0] ?? null;
  const firstRemoteStream = firstRemoteId ? peerStreams[firstRemoteId] : null;
  const totalParticipants = peerIds.length + 1; // you + remotes

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

  const effectiveCaptionLines = Math.max(1, captionLines || 3);

  // ---- Render -----------------------------------------------
  return (
    <div className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="relative h-full w-full">
        {/* Header overlay */}
        <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between gap-2 flex-wrap px-4 py-2 bg-gradient-to-b from-black/70 to-transparent">
          {/* Left: room code */}
          <div className="flex items-center gap-2">
            {roomInfo?.code && (
              <>
                <span className="text-xs text-neutral-300">Room Code</span>
                <span className="px-3 py-1 rounded-full bg-neutral-900/80 border border-neutral-700 font-mono tracking-[0.25em] text-xs md:text-sm">
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

            <button onClick={toggleCamera} className={`${pillBase} ${camClass}`}>
              {camOn ? "Cam On" : "Cam Off"}
            </button>

            {/* CC toggle + lines selector */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => setShowCaptions((v) => !v)}
                className={`${pillBase} ${
                  showCaptions
                    ? "bg-blue-500 text-white border-blue-400"
                    : "bg-neutral-900 text-neutral-100 border-neutral-700"
                }`}
              >
                CC
              </button>
              {showCaptions && (
                <select
                  value={captionLines}
                  onChange={(e) => setCaptionLines(Number(e.target.value) || 3)}
                  className="bg-neutral-900 text-xs border border-neutral-700 rounded-full px-2 py-1"
                >
                  <option value={1}>1</option>
                  <option value={2}>2</option>
                  <option value={3}>3</option>
                  <option value={4}>4</option>
                  <option value={5}>5</option>
                </select>
              )}
            </div>

            {/* Text input toggle */}
            <button
              onClick={() => setShowTextInput((v) => !v)}
              className={`${pillBase} ${
                showTextInput
                  ? "bg-emerald-600 text-white border-emerald-500"
                  : "bg-neutral-900 text-neutral-100 border-neutral-700"
              }`}
            >
              Text
            </button>

            {/* DEBUG ONLY: language overrides */}
            {debugMode && (
              <div className="flex items-center gap-1 ml-2">
                <span className="hidden md:inline text-[10px] text-neutral-400">Debug</span>
                <select
                  value={debugSpeakLang}
                  onChange={(e) => setDebugSpeakLang(e.target.value)}
                  className="bg-neutral-900 text-xs border border-neutral-700 rounded-full px-2 py-1"
                  title="Force STT speaking language (what browser listens as)"
                >
                  <option value="">Speak: Auto</option>
                  <option value="en-US">Speak: English</option>
                  <option value="pt-BR">Speak: Português</option>
                </select>
                <select
                  value={debugReadLang}
                  onChange={(e) => setDebugReadLang(e.target.value)}
                  className="bg-neutral-900 text-xs border border-neutral-700 rounded-full px-2 py-1"
                  title="Force caption translation language (what you read)"
                >
                  <option value="">Read: Auto</option>
                  <option value="en-US">Read: English</option>
                  <option value="pt-BR">Read: Português</option>
                </select>
              </div>
            )}
          </div>
        </header>

        {/* Main content area */}
        <main className="absolute inset-0 pt-10 md:pt-14">
          {needsUnmute && (
            <div className="absolute top-16 left-1/2 -translate-x-1/2 z-30 max-w-md w-[90%] p-3 rounded-xl bg-amber-900/80 border border-amber-500/60 shadow-lg">
              <p className="text-sm">
                Your browser blocked autoplay with sound. Tap below to start remote audio.
              </p>
              <button
                onClick={handleUnmuteClick}
                className="mt-2 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-500 text-sm"
              >
                Unmute Remote Audio
              </button>
            </div>
          )}

          {/* Optional small STT status text */}
          {showCaptions && sttStatus !== "ok" && (
            <div className="absolute top-16 left-4 z-20 text-[10px] md:text-xs text-amber-300 bg-black/60 px-2 py-1 rounded">
              {sttStatus === "unsupported"
                ? "Live captions mic not supported on this device. Use Text button."
                : sttStatus === "error"
                ? sttErrorMessage || "Live captions mic error. Use Text button."
                : "Checking live captions mic..."}
            </div>
          )}

          {/* Layouts */}
          <div className="h-full w-full">
            {/* Only you in the room */}
            {peerIds.length === 0 && (
              <div className="relative h-full w-full bg-neutral-900">
                <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                  {myHandUp && <span>✋</span>}
                  <span>You</span>
                </div>
              </div>
            )}

            {/* Exactly 1 remote */}
            {peerIds.length === 1 && firstRemoteId && (
              <div className="relative h-full w-full bg-neutral-900">
                {/* Remote big - FIX: object-contain to avoid portrait crop */}
                <video
                  autoPlay
                  playsInline
                  className="h-full w-full object-contain bg-black"
                  ref={(el) => {
                    if (el && firstRemoteStream && el.srcObject !== firstRemoteStream) el.srcObject = firstRemoteStream;
                  }}
                />
                <audio
                  data-remote
                  autoPlay
                  ref={(el) => {
                    if (!el || !firstRemoteId) return;
                    const stream = peerStreams[firstRemoteId];
                    if (!stream) return;
                    if (el.srcObject !== stream) el.srcObject = stream;
                  }}
                />

                <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                  {handsUp[firstRemoteId] && <span>✋</span>}
                  <span>{peerLabels[firstRemoteId] ?? firstRemoteId.slice(0, 8)}</span>
                </div>

                {/* Local PiP */}
                <div className="absolute bottom-4 right-4 w-32 h-20 md:w-48 md:h-28 rounded-xl overflow-hidden border border-neutral-700 bg-black/70 shadow-lg">
                  <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                  <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded flex items-center gap-1">
                    {myHandUp && <span>✋</span>}
                    <span>You</span>
                  </div>
                </div>
              </div>
            )}

            {/* 3–4 total participants */}
            {peerIds.length > 1 && totalParticipants <= 4 && (
              <div className="grid h-full w-full gap-2 p-2 md:p-4 grid-cols-1 sm:grid-cols-2 auto-rows-fr">
                {/* Local tile */}
                <div className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0">
                  <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                  <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                    {myHandUp && <span>✋</span>}
                    <span>You</span>
                  </div>
                </div>

                {/* Remote tiles - FIX: object-contain for phone portrait */}
                {peerIds.map((pid) => (
                  <div key={pid} className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0">
                    <video
                      autoPlay
                      playsInline
                      className="h-full w-full object-contain bg-black"
                      ref={(el) => {
                        const stream = peerStreams[pid];
                        if (el && stream && el.srcObject !== stream) el.srcObject = stream;
                      }}
                    />
                    <audio
                      data-remote
                      autoPlay
                      ref={(el) => {
                        const stream = peerStreams[pid];
                        if (!el || !stream) return;
                        if (el.srcObject !== stream) el.srcObject = stream;
                      }}
                    />
                    <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                      {handsUp[pid] && <span>✋</span>}
                      <span>{peerLabels[pid] ?? pid.slice(0, 8)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 5+ participants: spotlight + thumbnails */}
            {totalParticipants >= 5 && (
              <div className="flex flex-col h-full w-full">
                {/* Spotlight */}
                <div className="relative flex-1 bg-neutral-900 rounded-none md:rounded-2xl overflow-hidden m-0 md:m-2">
                  {spotlightId === "local" ? (
                    <>
                      <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                      <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                        {myHandUp && <span>✋</span>}
                        <span>You</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <video
                        autoPlay
                        playsInline
                        className="h-full w-full object-contain bg-black"
                        ref={(el) => {
                          const stream = peerStreams[spotlightId];
                          if (el && stream && el.srcObject !== stream) el.srcObject = stream;
                        }}
                      />
                      <audio
                        data-remote
                        autoPlay
                        ref={(el) => {
                          const stream = peerStreams[spotlightId];
                          if (!el || !stream) return;
                          if (el.srcObject !== stream) el.srcObject = stream;
                        }}
                      />
                      <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                        {handsUp[spotlightId] && <span>✋</span>}
                        <span>{peerLabels[spotlightId] ?? spotlightId.slice(0, 8)}</span>
                      </div>
                    </>
                  )}
                </div>

                {/* Thumbnails */}
                <div className="mt-2 flex gap-2 overflow-x-auto px-2 pb-3">
                  {spotlightId !== "local" && (
                    <button
                      type="button"
                      onClick={() => setSpotlightId("local")}
                      className="relative h-20 md:h-24 aspect-video bg-neutral-900 rounded-xl overflow-hidden border border-neutral-700/80 flex-shrink-0"
                    >
                      <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                      <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded flex items-center gap-1">
                        {myHandUp && <span>✋</span>}
                        <span>You</span>
                      </div>
                    </button>
                  )}

                  {peerIds.map((pid) => {
                    const isSpot = pid === spotlightId;
                    return (
                      <button
                        key={pid}
                        type="button"
                        onClick={() => setSpotlightId(pid)}
                        className={`relative h-20 md:h-24 aspect-video rounded-xl overflow-hidden flex-shrink-0 border ${
                          isSpot ? "border-emerald-500" : "border-neutral-700/80"
                        } bg-neutral-900`}
                      >
                        <video
                          autoPlay
                          playsInline
                          className="h-full w-full object-contain bg-black"
                          ref={(el) => {
                            const stream = peerStreams[pid];
                            if (el && stream && el.srcObject !== stream) el.srcObject = stream;
                          }}
                        />
                        <audio
                          data-remote
                          autoPlay
                          ref={(el) => {
                            const stream = peerStreams[pid];
                            if (!el || !stream) return;
                            if (el.srcObject !== stream) el.srcObject = stream;
                          }}
                        />
                        <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded flex items-center gap-1">
                          {handsUp[pid] && <span>✋</span>}
                          <span>{peerLabels[pid] ?? pid.slice(0, 8)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Subtitle overlay */}
          {showCaptions && messages.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
              <div className="max-w-xl w-[92%] space-y-2">
                {messages.slice(-effectiveCaptionLines).map((m) => (
                  <div
                    key={m.id}
                    className="bg-black/70 backdrop-blur rounded-xl px-3 py-2 text-xs md:text-sm border border-white/10"
                  >
                    <div className="flex justify-between text-[10px] text-neutral-300 mb-0.5">
                      <span>{m.isLocal ? "You" : m.fromName}</span>
                      <span>
                        {m.originalLang} → {m.translatedLang}
                      </span>
                    </div>
                    {m.originalLang !== m.translatedLang && (
                      <div className="text-[10px] text-neutral-400 italic mb-0.5">
                        {m.originalText}
                      </div>
                    )}
                    <div className="text-sm">{m.translatedText}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Manual text input */}
          {showTextInput && (
            <form onSubmit={handleTextSubmit} className="pointer-events-auto absolute inset-x-0 bottom-16 flex justify-center">
              <div className="flex gap-2 w-[92%] max-w-xl">
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Type a quick caption…"
                  className="flex-1 rounded-full px-3 py-2 text-sm bg-black/70 border border-neutral-700 outline-none"
                />
                <button type="submit" className="px-3 py-2 rounded-full text-sm bg-emerald-600 hover:bg-emerald-500 text-white">
                  Send
                </button>
              </div>
            </form>
          )}
        </main>

        {/* Hand raise button */}
        <button
          type="button"
          onClick={toggleHand}
          className="fixed bottom-4 right-4 z-30 rounded-full w-12 h-12 flex items-center justify-center bg-amber-500 hover:bg-amber-400 text-black shadow-lg"
        >
          <span className="text-xl">✋</span>
        </button>
      </div>
    </div>
  );
}
