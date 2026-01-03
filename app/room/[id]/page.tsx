"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { LANGUAGES } from "@/lib/languages";
import { useCallMode } from "@/hooks/useCallMode";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useAnySpeakTts } from "@/hooks/useAnySpeakTts";
import { useAnySpeakRealtime } from "@/hooks/useAnySpeakRealtime";
import { useAnySpeakRoomMedia } from "@/hooks/useAnySpeakRoomMedia";
import { useAnySpeakStt } from "@/hooks/useAnySpeakStt";
import { useAnySpeakMessages, type AnySpeakChatMessage } from "@/hooks/useAnySpeakMessages";
import { useAnySpeakWebRtc, type AnySpeakPeer } from "@/hooks/useAnySpeakWebRtc";

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
  name?: string;
};

type Peer = AnySpeakPeer;

type PeerStreams = Record<string, MediaStream>;

type RoomType = "audio" | "video";

type RoomInfo = {
  code: string | null;
  room_type: RoomType;
};


type SttStatus = "unknown" | "ok" | "unsupported" | "error";

// Pick a safe default that actually exists in LANGUAGES
function pickSupportedLang(preferred?: string) {
  const fallback = "en-US";
  const pref = (preferred || "").trim();
  if (!pref) return fallback;

  if (LANGUAGES.some((l) => l.code === pref)) return pref;

  const base = pref.slice(0, 2).toLowerCase();
  const baseMatch =
    LANGUAGES.find((l) => l.code.toLowerCase() === base) ||
    LANGUAGES.find((l) => l.code.toLowerCase().startsWith(base));

  return baseMatch?.code || fallback;
}

// (TTS moved to useAnySpeakTts hook)

/**
 * Front-end helper: call /api/translate
 */
async function translateText(
  fromLang: string,
  toLang: string,
  text: string
): Promise<{ translatedText: string; targetLang: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { translatedText: "", targetLang: toLang };
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
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  // ---- Debug Mode + URL params ---------------------------------
  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";
  const debugKey = debugEnabled ? "debug" : "normal";

  const isMobile = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
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
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const peerLabelsRef = useRef<Record<string, string>>({});
  const recognitionRef = useRef<any>(null);

  const shouldSpeakTranslatedRef = useRef(false);
  const shouldMuteRawAudioRef = useRef(true);

  // Track if user manually touched mic so we don't "helpfully" auto-mute later
  const userTouchedMicRef = useRef(false);


  const micOnRef = useRef(false);
  const micArmedRef = useRef(false); // user intent (armed)
  const pttHeldRef = useRef(false);

  const displayNameRef = useRef<string>("You");

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");

  const [spotlightId, setSpotlightId] = useState<string>("local");

  // ---- Local preview (PiP) behavior -------------------------
  // Draggable + auto-fade after a few seconds (tap brings it back)
  const pipRef = useRef<HTMLDivElement | null>(null);
  const pipHideTimerRef = useRef<number | null>(null);
  const pipDraggingRef = useRef(false);
  const pipDragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);
  const [pipVisible, setPipVisible] = useState(true);

  const clearPipTimer = () => {
    if (pipHideTimerRef.current) {
      window.clearTimeout(pipHideTimerRef.current);
      pipHideTimerRef.current = null;
    }
  };

  const schedulePipHide = () => {
    clearPipTimer();
    pipHideTimerRef.current = window.setTimeout(() => {
      setPipVisible(false);
    }, 2500);
  };

  // Set an initial position (bottom-right-ish) once we know the PiP size.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pipPos) return;
    // Only relevant in 1:1 view (remote full + local PiP)
    if (peerIds.length !== 1) return;

    const el = pipRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 96;

    // Keep above the bottom dock.
    const pad = 16;
    const dock = 120;
    const x = Math.max(pad, window.innerWidth - w - pad);
    const y = Math.max(pad, window.innerHeight - h - dock);

    setPipPos({ x, y });
    setPipVisible(true);
    schedulePipHide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerIds.length]);

  // Keep PiP inside viewport on resize.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!pipPos) return;
    const onResize = () => {
      const el = pipRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pad = 8;
      const dock = 120;
      const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
      const maxY = Math.max(pad, window.innerHeight - rect.height - dock);
      setPipPos((p) => (p ? { x: Math.min(Math.max(p.x, pad), maxX), y: Math.min(Math.max(p.y, pad), maxY) } : p));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pipPos]);

  const pipShowNow = () => {
    setPipVisible(true);
    schedulePipHide();
  };

  const pipOnPointerDown = (e: React.PointerEvent) => {
    // Tap brings it back even if it was faded.
    pipShowNow();

    if (!pipPos) return;
    pipDraggingRef.current = true;
    clearPipTimer();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}

    pipDragOffsetRef.current = {
      dx: e.clientX - pipPos.x,
      dy: e.clientY - pipPos.y,
    };
  };

  const pipOnPointerMove = (e: React.PointerEvent) => {
    if (!pipDraggingRef.current) return;
    const el = pipRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const pad = 8;
    const dock = 120;

    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(pad, window.innerHeight - rect.height - dock);

    const x = e.clientX - pipDragOffsetRef.current.dx;
    const y = e.clientY - pipDragOffsetRef.current.dy;

    setPipPos({
      x: Math.min(Math.max(x, pad), maxX),
      y: Math.min(Math.max(y, pad), maxY),
    });
  };

  const pipOnPointerUpOrCancel = (e: React.PointerEvent) => {
    if (!pipDraggingRef.current) {
      // It was just a tap.
      pipShowNow();
      return;
    }
    pipDraggingRef.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    schedulePipHide();
  };

  // Default PiP position: bottom-right, above the dock
  useEffect(() => {
    if (pipPos) return;
    if (typeof window === "undefined") return;
    const el = pipRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 16;
    const dockPad = 120;
    const x = Math.max(margin, window.innerWidth - rect.width - margin);
    const y = Math.max(margin, window.innerHeight - rect.height - dockPad);
    setPipPos({ x, y });
    schedulePipHide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pipRef.current]);

  // Clean up timer
  useEffect(() => {
    return () => clearPipTimer();
  }, []);

  // Captions / text stream
  const { messages, pushMessage, clearMessages } = useAnySpeakMessages({ max: 30 });
  const [captionLines, setCaptionLines] = useState<number>(3);

  // Manual text captions
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [ccOn, setCcOn] = useState(true);

  // STT status

  // ✅ Enforced room mode (from DB)
  const roomType: RoomType | null = roomInfo?.room_type ?? null;

  // ✅ Joiner camera choice for VIDEO rooms (creator still chose "video")
  // null => not chosen yet (we can show a small overlay)
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);

  // Pre-join: joiner does NOT choose audio/video anymore
  const prejoinDone =
    roomType === "audio" ? true : roomType === "video" ? joinCamOn !== null : false;

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 250));
  };



  // ---------- FINAL vs DEBUG behavior ----------
  const FINAL_MUTE_RAW_AUDIO = true;
  const FINAL_AUTOSPEAK_TRANSLATED = true;

  // Debug toggles
  const [debugHearRawAudio, setDebugHearRawAudio] = useState(false);
  const [debugSpeakTranslated, setDebugSpeakTranslated] = useState(false);

  // Debug: choose what YOU speak (STT input language)
  const initialSpeak = useMemo(() => {
    if (typeof navigator === "undefined") return "en-US";
    return pickSupportedLang(navigator.language || "en-US");
  }, []);
  const [speakLang, setSpeakLang] = useState<string>(initialSpeak);
  const speakLangRef = useRef<string>(initialSpeak);

  // Debug: choose what YOU want captions shown in
  const initialTarget = useMemo(() => {
    if (typeof navigator === "undefined") return "en-US";
    return pickSupportedLang(navigator.language || "en-US");
  }, []);
  const [targetLang, setTargetLang] = useState<string>(initialTarget);
  const targetLangRef = useRef<string>(initialTarget);

  // ✅ Stable translated TTS output + Android/Chrome "gesture unlock"
  const { speakText, unlockTts } = useAnySpeakTts({
    getLang: () => targetLangRef.current || "en-US",
    onLog: (m, data) => log(m, data ?? {}),
  });

  // effective behavior flags
  const shouldMuteRawAudio = FINAL_MUTE_RAW_AUDIO && !debugHearRawAudio;
  const shouldSpeakTranslated =
    FINAL_AUTOSPEAK_TRANSLATED || (debugEnabled && debugSpeakTranslated);


// (ICE queue moved to useAnySpeakWebRtc hook)


  // ---- keep refs updated ------------------------------------
  useEffect(() => {
    shouldMuteRawAudioRef.current = shouldMuteRawAudio;
  }, [shouldMuteRawAudio]);

  useEffect(() => {
    targetLangRef.current = targetLang;
  }, [targetLang]);

  useEffect(() => {
    speakLangRef.current = speakLang;
  }, [speakLang]);

  useEffect(() => {
    shouldSpeakTranslatedRef.current =
      FINAL_AUTOSPEAK_TRANSLATED || (debugEnabled && debugSpeakTranslated);
  }, [debugEnabled, debugSpeakTranslated]);

  useEffect(() => {
    displayNameRef.current = displayName || "You";
  }, [displayName]);

  // (TTS gesture unlock handled inside useAnySpeakTts)

  // Keep remote audio tracks in sync with the mute policy
  useEffect(() => {
    const allowRaw = !shouldMuteRawAudioRef.current;
    Object.values(peerStreams).forEach((stream) => {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = allowRaw;
      });
    });
  }, [peerStreams, shouldMuteRawAudio]);

  // ---- Load display name from localStorage -------------------
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("displayName");
    if (saved) setDisplayName(saved);
  }, []);

  // ---- Load room info (code + room_type) from Supabase -------
  useEffect(() => {
    if (!roomId) return;

    (async () => {
      try {
        const { data, error } = await supabase
          .from("rooms")
          .select("code, room_type")
          .eq("id", roomId)
          .maybeSingle();

        if (error) {
          log("room load error", { message: error.message });
          return;
        }

        const dbType = (data?.room_type || "audio") as RoomType;
        const safeType: RoomType = dbType === "video" ? "video" : "audio";

        setRoomInfo({ code: (data?.code ?? null) as any, room_type: safeType });
        log("room loaded", { safeType });

        // ✅ If it's an audio room, auto-join immediately (no popups)
        if (safeType === "audio") {
          setJoinCamOn(false);
        } else {
          // video room: if we haven't asked, default to "ask"
          // you can change this default if you want it auto-join with cam ON:
          // setJoinCamOn(true);
        }
      } catch (err) {
        log("room load error", { err: (err as Error).message });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);


  // ✅ STT send helper (hook already handles duplicate protection)
  const sendFinalTranscript = async (finalText: string, recLang: string) => {
    const text = (finalText || "").trim();
    if (!text) return;

    const lang = recLang || "en-US";
    const fromName = displayNameRef.current || "You";
    const target = targetLangRef.current || "en-US";

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

    // IMPORTANT: no local speak

    if (channelRef.current) {
      channelRef.current.send({
        type: "broadcast",
        event: "transcript",
        payload: { from: clientId, text, lang, name: fromName },
      });
    } else {
      log("stt send skipped (no channelRef)", {});
    }

    log("stt sent transcript", { lang, textLen: text.length });
  };


  
  // ---- Hooks you built ---------------------------------------
  // ✅ Enforce modeParam from room_type (creator decides)
  const enforcedModeParam: "audio" | "video" = roomType === "video" ? "video" : "audio";

  const participantCount = peerIds.length + 1;
  const { mode } = useCallMode({
    modeParam: enforcedModeParam,
    participantCount,
  });

  const localMedia = useLocalMedia({
    wantVideo: mode === "video",
    wantAudio: !isMobile, // mobile: DO NOT grab mic via getUserMedia (STT uses mic)
  });

  const {
    localStreamRef,
    micOn,
    camOn,
    acquire,
    attachLocalVideo,
    setMicEnabled,
    setCamEnabled,
  } = localMedia;

  // ---- Hook #3: room media (camera + getUserMedia policy) ----
const { beforeConnect, toggleCamera } = useAnySpeakRoomMedia({
  isMobile,
  roomType,
  joinCamOn,

  // ✅ return the MediaStream so the hook matches the type
  acquire: async () => {
    return await acquire();
  },

  localStreamRef,
  setCamEnabled,
  log,
});


  // ---- Hook #5: STT (Web Speech API + PTT) ------------------
  const {
    sttListening,
    sttArmedNotListening,
    sttStatus,
    sttErrorMessage,
    toggleMic,
    pttDown,
    pttUp,
    pttCancel,
    startSttNow,
    stopSttNow,
    stopAllStt,
  } = useAnySpeakStt({
    isMobile,
    debugKey,
    speakLang,
    userTouchedMicRef,
    micOnRef,
    micArmedRef,
    pttHeldRef,
    micOn,
    setMicEnabled,
    unlockTts,
    log: (m, data) => log(m, data ?? {}),
    onFinalTranscript: (text, recLang) => {
      void sendFinalTranscript(text, recLang);
    },
  });



  const micUiOn = isMobile ? sttListening : micOn;

  // ---- Helpers ----------------------------------------------
  function upsertPeerStream(remoteId: string, stream: MediaStream) {
    setPeerStreams((prev) => ({ ...prev, [remoteId]: stream }));
  }

  function teardownPeers(reason: string) {
    log("teardownPeers", { reason });
    clearPendingIce();

    peersRef.current.forEach(({ pc }) => {
      try {
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.onicegatheringstatechange = null;
        pc.close();
      } catch {}
    });
    peersRef.current.clear();

    setPeerIds([]);
    setPeerStreams({});
    setPeerLabels({});
    peerLabelsRef.current = {};
    setConnected(false);
  }

  // ---- ICE servers (STUN + optional TURN) -------------------
  const { iceServers, turnEnabled, turnUrlsCount, turnMissing } = useMemo(() => {
    const turnUrls = (process.env.NEXT_PUBLIC_TURN_URLS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const turnUsername = process.env.NEXT_PUBLIC_TURN_USERNAME || "";
    const turnCredential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL || "";

    const servers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302"] }];

    const enabled = !!(turnUrls.length && turnUsername && turnCredential);

    if (enabled) {
      servers.push({
        urls: turnUrls,
        username: turnUsername,
        credential: turnCredential,
      });
    }

    return {
      iceServers: servers,
      turnEnabled: enabled,
      turnUrlsCount: turnUrls.length,
      turnMissing: {
        urls: turnUrls.length === 0,
        username: !turnUsername,
        credential: !turnCredential,
      },
    };
  }, []);

  // ✅ Log once (NO render-loop)
  useEffect(() => {
    if (turnEnabled) {
      log("TURN enabled", { turnUrlsCount });
    } else {
      log("TURN not configured", turnMissing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Hook #4: WebRTC peer + signaling helpers -------------
  const { makeOffer, handleOffer, handleAnswer, handleIce, clearPendingIce } =
    useAnySpeakWebRtc({
      clientId,
      isMobile,
      iceServers,
      localStreamRef,
      peersRef,
      shouldMuteRawAudioRef,
      setConnected,
      log,
      upsertPeerStream,
    });



  // ---- RAW AUDIO KILL SWITCH (element-level, reliable on mobile) ------------
  useEffect(() => {
    const allowRaw = !shouldMuteRawAudio;

    document.querySelectorAll<HTMLAudioElement>("audio[data-remote]").forEach((a) => {
      a.muted = !allowRaw;
      a.volume = allowRaw ? 1 : 0;
      if (allowRaw) a.play().catch(() => {});
    });

    document.querySelectorAll<HTMLVideoElement>("video").forEach((v) => {
      if ((v as any).dataset?.local === "1") return; // avoid local video element
      v.muted = !allowRaw;
      v.volume = allowRaw ? 1 : 0;
      if (allowRaw) v.play().catch(() => {});
    });
  }, [shouldMuteRawAudio, peerStreams, peerIds]);

  // ---- Lifecycle: join room, wire realtime -------------------
  const { rtStatus, channelRef } = useAnySpeakRealtime({
    roomId,
    clientId,
    prejoinDone,
    roomType,
    joinCamOn,
    debugKey,
    displayNameRef,
    log,
    teardownPeers,
    // Runs before the channel is created (keeps exact ordering vs previous code)
    beforeConnect,
    onWebrtc: async (message, channel) => {
      const payload = message?.payload as WebRTCPayload | undefined;
      if (!payload) return;
      const { type, from, to } = payload;
      log("rx webrtc", { type, from, to });
      if (!type || !from) return;
      if (from === clientId) return;
      if (to && to !== clientId) return;

      if (type === "offer" && payload.sdp) {
        await handleOffer(from, payload.sdp, channel);
      } else if (type === "answer" && payload.sdp) {
        await handleAnswer(from, payload.sdp);
      } else if (type === "ice" && payload.candidate) {
        await handleIce(from, payload.candidate);
      }
    },
    onTranscript: async (message) => {
      const payload = message?.payload as TranscriptPayload | undefined;
      if (!payload) return;
      const { from, text, lang, name } = payload;
      log("rx transcript", { from, lang, textLen: (text || "").length });

      if (!text || !from || from === clientId) return;

      const fromName =
        name ?? peerLabelsRef.current[from] ?? from.slice(0, 8) ?? "Guest";

      const target = targetLangRef.current || "en-US";
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

      if (shouldSpeakTranslatedRef.current) {
        unlockTts();
        speakText(translatedText, outLang, 0.9);
      }
    },
    onPresenceSync: (channel) => {
      const state = channel.presenceState() as Record<string, any[]>;
      const others: string[] = [];
      const labels: Record<string, string> = {};

      Object.values(state).forEach((arr) => {
        arr.forEach((m: any) => {
          if (!m?.clientId) return;
          if (m.clientId === clientId) return;
          others.push(m.clientId);
          labels[m.clientId] = (m.name as string | undefined) || m.clientId.slice(0, 8);
        });
      });

      setPeerIds(others);
      setPeerLabels(labels);
      peerLabelsRef.current = labels;

      // 3+ users default: mic OFF (unless user already touched mic)
      const total = others.length + 1;
      if (total >= 3 && !userTouchedMicRef.current) {
        if (!isMobile) {
          setMicEnabled(false);
        }

        micOnRef.current = false;
        if (isMobile) {
          stopAllStt("auto-muted-3plus");
        } else {
          stopAllStt("auto-muted");
        }

        log("auto-muted for 3+ participants", { total });
      }

      others.forEach((id) => {
        if (!peersRef.current.has(id)) {
          makeOffer(id, channel).catch(() => {});
        }
      });
    },
  });

  // ---- UI controls ------------------------------------------

  const handleTextSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = textInput.trim();
    if (!text) return;

    const lang = (debugEnabled ? speakLangRef.current : (navigator.language as string)) || "en-US";

    const fromName = displayNameRef.current || "You";
    const target = targetLangRef.current || "en-US";
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
  const totalParticipants = peerIds.length + 1;

  const pillBase =
    "inline-flex items-center justify-center px-4 py-1 rounded-full text-xs md:text-sm font-medium border transition-colors";

  const online = rtStatus === "SUBSCRIBED";
  const connectedClass = online
    ? "bg-emerald-600/90 text-white border-emerald-500"
    : "bg-red-900/70 text-red-200 border-red-700";

  const micClass = sttListening
    ? "bg-neutral-800 text-neutral-50 border-neutral-600"
    : "bg-red-900/80 text-red-100 border-red-700";

  const camClass = camOn
    ? "bg-neutral-100 text-neutral-900 border-neutral-300"
    : "bg-red-900/80 text-red-100 border-red-700";

  const effectiveCaptionLines = Math.max(1, captionLines || 3);

  // ---- Render -----------------------------------------------
  return (
    <div className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="relative h-full w-full overflow-hidden">
        {/* ✅ Joiner overlay: only for VIDEO room to choose cam on/off.
            Audio rooms auto-join; joiners no longer choose audio/video. */}
        {roomType === "video" && joinCamOn === null && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-4">
              <div className="text-lg font-semibold mb-2">Video room</div>
              <div className="text-sm text-neutral-300 mb-4">
                Join with camera on or off.
              </div>

              <div className="grid grid-cols-1 gap-2">
                <button
                  className="rounded-xl border border-neutral-700 bg-emerald-600 px-3 py-3 text-sm text-white"
                  onClick={() => setJoinCamOn(true)}
                >
                  Join with Camera ON
                </button>

                <button
                  className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-3 text-sm"
                  onClick={() => setJoinCamOn(false)}
                >
                  Join with Camera OFF
                </button>
              </div>

              <div className="mt-3 text-[11px] text-neutral-400">
                Room type is set by the creator.
              </div>
            </div>
          </div>
        )}

        {/* Top floating controls (no code, no audio/video) */}
        <header className="absolute top-2 left-2 right-2 z-20 pointer-events-none">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={async () => {
                try {
                  const url = window.location.href;
                  // @ts-ignore
                  if (navigator.share) {
                    // @ts-ignore
                    await navigator.share({ url, text: "Join my Any-Speak room" });
                  } else {
                    await navigator.clipboard.writeText(url);
                    log("copied room link", { url });
                  }
                } catch {
                  try {
                    const url = window.location.href;
                    await navigator.clipboard.writeText(url);
                    log("copied room link", { url });
                  } catch {}
                }
              }}
              className="pointer-events-auto px-3 py-1.5 rounded-full bg-black/25 backdrop-blur-md border border-white/10 text-[11px] text-white/90 shadow"
            >
              Share
            </button>

            <span
              className={`pointer-events-auto px-3 py-1.5 rounded-full text-[11px] shadow backdrop-blur-md border border-white/10 ${
                online ? "bg-emerald-600/55 text-white" : "bg-red-600/45 text-white"
              }`}
            >
              {online ? "Online" : "Offline"}
            </span>
          </div>
        </header>

        <main className="absolute inset-0 pt-0 md:pt-14">
          {/* Debug Panel */}
          {debugEnabled && (
            <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 w-[95%] max-w-2xl p-3 rounded-xl bg-neutral-900/90 border border-neutral-700 shadow-lg">
              <div className="text-xs text-neutral-300 mb-2">
                Debug Mode (URL has <span className="font-mono">?debug=1</span>)
                {isMobile ? " · Mobile" : " · Desktop"}
              </div>

              <button
                type="button"
                onClick={() => {
                  unlockTts();
                  speakText("Teste de voz", "pt-BR", 0.95);
                }}
                className="px-3 py-2 rounded-lg text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                Test Voice
              </button>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mt-2">
                <label className="text-xs">
                  <div className="text-neutral-300 mb-1">I speak (STT)</div>
                  <select
                    value={speakLang}
                    onChange={(e) => setSpeakLang(e.target.value)}
                    className="w-full bg-black/60 text-xs border border-neutral-700 rounded-lg px-2 py-2"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label} ({l.code})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="text-xs">
                  <div className="text-neutral-300 mb-1">Show captions in</div>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="w-full bg-black/60 text-xs border border-neutral-700 rounded-lg px-2 py-2"
                  >
                    {LANGUAGES.map((l) => (
                      <option key={l.code} value={l.code}>
                        {l.label} ({l.code})
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={debugHearRawAudio}
                      onChange={(e) => setDebugHearRawAudio(e.target.checked)}
                    />
                    <span className="text-neutral-200">Hear raw audio</span>
                  </label>

                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={debugSpeakTranslated}
                      onChange={(e) => setDebugSpeakTranslated(e.target.checked)}
                    />
                    <span className="text-neutral-200">Speak translated</span>
                  </label>

                  <div className="text-[10px] text-neutral-400">
                    Tip: after changing “I speak”, hold to talk again.
                  </div>
                </div>
              </div>

              <div className="mt-2 text-[10px] text-neutral-400">
                Raw audio muted:{" "}
                <span className="font-mono">{shouldMuteRawAudio ? "true" : "false"}</span>{" "}
                · Speak translated:{" "}
                <span className="font-mono">{shouldSpeakTranslated ? "true" : "false"}</span>{" "}
                · Connected: <span className="font-mono">{connected ? "true" : "false"}</span>
              </div>

              <div className="mt-3 max-h-40 overflow-auto rounded-lg bg-black/50 border border-neutral-700 p-2">
                <div className="text-[10px] text-neutral-400 mb-1">Logs</div>
                <pre className="text-[10px] leading-snug whitespace-pre-wrap text-neutral-200">
                  {logs.slice(0, 20).join("\n")}
                </pre>
              </div>
            </div>
          )}

          {/* STT status */}
          {sttStatus !== "ok" && (
            <div className="absolute top-[calc(env(safe-area-inset-top)+52px)] left-3 z-20 text-[10px] md:text-xs text-amber-200 bg-black/45 backdrop-blur px-2 py-1 rounded-full border border-white/10">
              {sttStatus === "unsupported"
                ? "Live captions mic not supported on this device. Use Text."
                : sttStatus === "error"
                ? sttErrorMessage || "Live captions mic error. Use Text."
                : "Checking live captions mic..."}
            </div>
          )}

          {isMobile && sttArmedNotListening && (
            <div className="absolute top-[calc(env(safe-area-inset-top)+52px)] left-3 z-20 text-[10px] md:text-xs text-sky-200 bg-black/45 backdrop-blur px-2 py-1 rounded-full border border-white/10">
              Captions paused. Hold to Talk.
            </div>
          )}

          <div className="h-full w-full">
            {peerIds.length === 0 && (
              <div className="relative h-full w-full bg-neutral-900">
                <video
                  data-local="1"
                  ref={attachLocalVideo}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover"
                />
                <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                  <span>You</span>
                </div>
              </div>
            )}

            {peerIds.length === 1 && firstRemoteId && (
              <div className="relative h-full w-full bg-neutral-900">
                <video
                  autoPlay
                  playsInline
                  className="h-full w-full object-cover"
                  ref={(el) => {
                    if (el && firstRemoteStream && el.srcObject !== firstRemoteStream) {
                      el.srcObject = firstRemoteStream;
                      el.playsInline = true as any;
                      el.play().catch(() => {});
                    }
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
                  <span>{peerLabels[firstRemoteId] ?? firstRemoteId.slice(0, 8)}</span>
                </div>

                {/* Local preview (draggable PiP) */}
                <div
                  ref={pipRef}
                  className={
                    "absolute rounded-xl overflow-hidden border border-neutral-700 bg-black/70 shadow-lg transition-opacity duration-500 " +
                    (pipVisible ? "opacity-100" : "opacity-15")
                  }
                  style={
                    pipPos
                      ? {
                          left: pipPos.x,
                          top: pipPos.y,
                          width: "12rem", // ~w-48
                          height: "7rem", // ~h-28
                        }
                      : {
                          right: "1rem",
                          bottom: "4rem",
                          width: "12rem",
                          height: "7rem",
                        }
                  }
                  onPointerDown={pipOnPointerDown}
                  onPointerMove={pipOnPointerMove}
                  onPointerUp={pipOnPointerUpOrCancel}
                  onPointerCancel={pipOnPointerUpOrCancel}
                  onDoubleClick={() => {
                    setPipPos(null);
                    pipShowNow();
                  }}
                >
                  <video
                    data-local="1"
                    ref={attachLocalVideo}
                    autoPlay
                    playsInline
                    muted
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded flex items-center gap-1">
                    <span>You</span>
                  </div>
                </div>
              </div>
            )}

            {peerIds.length > 1 && totalParticipants <= 4 && (
              <div className="grid h-full w-full gap-2 p-2 md:p-4 grid-cols-1 sm:grid-cols-2 auto-rows-fr">
                <div className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0">
                  <video
                    data-local="1"
                    ref={attachLocalVideo}
                    autoPlay
                    playsInline
                  muted
                    className="h-full w-full object-cover"
                  />
                  <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                    <span>You</span>
                  </div>
                </div>

                {peerIds.map((pid) => (
                  <div
                    key={pid}
                    className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0"
                  >
                    <video
                      autoPlay
                      playsInline
                      className="h-full w-full object-cover"
                      ref={(el) => {
                        const stream = peerStreams[pid];
                        if (el && stream && el.srcObject !== stream) {
                          el.srcObject = stream;
                          el.playsInline = true as any;
                          el.play().catch(() => {});
                        }
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
                      <span>{peerLabels[pid] ?? pid.slice(0, 8)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {totalParticipants >= 5 && (
              <div className="flex flex-col h-full w-full">
                <div className="relative flex-1 bg-neutral-900 rounded-none md:rounded-2xl overflow-hidden m-0 md:m-2">
                  {spotlightId === "local" ? (
                    <>
                      <video
                        data-local="1"
                        ref={attachLocalVideo}
                        autoPlay
                        playsInline
                  muted
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                        <span>You</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <video
                        autoPlay
                        playsInline
                        className="h-full w-full object-cover"
                        ref={(el) => {
                          const stream = peerStreams[spotlightId];
                          if (el && stream && el.srcObject !== stream) {
                            el.srcObject = stream;
                          }
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
                        <span>{peerLabels[spotlightId] ?? spotlightId.slice(0, 8)}</span>
                      </div>
                    </>
                  )}
                </div>

                <div className="mt-2 flex gap-2 overflow-x-auto px-2 pb-3">
                  {spotlightId !== "local" && (
                    <button
                      type="button"
                      onClick={() => setSpotlightId("local")}
                      className="relative h-20 md:h-24 aspect-video bg-neutral-900 rounded-xl overflow-hidden border border-neutral-700/80 flex-shrink-0"
                    >
                      <video
                        data-local="1"
                        ref={attachLocalVideo}
                        autoPlay
                        playsInline
                  muted
                        className="h-full w-full object-cover"
                      />
                      <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded flex items-center gap-1">
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
                            if (!el || !stream) return;
                            if (el.srcObject !== stream) el.srcObject = stream;
                          }}
                        />
                        <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded flex items-center gap-1">
                          <span>{peerLabels[pid] ?? pid.slice(0, 8)}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Captions overlay (low + can overlap controls) */}
          {ccOn && messages.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              {/* Bottom fade so captions stay readable even over video + dock */}
              <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />

              <div
                className="relative flex flex-col gap-1.5 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]"
                style={{
                  // LOW: sits close to the bottom and may overlap dock/PTT.
                  // When text input is open, lift a bit so captions don't sit under the input.
                  paddingBottom: showTextInput
                    ? "calc(env(safe-area-inset-bottom) + 118px)"
                    : "calc(env(safe-area-inset-bottom) + 64px)",
                }}
              >
                {messages.slice(-effectiveCaptionLines).map((m, idx, arr) => {
                  const isNewest = idx === arr.length - 1;

                  return (
                    <div
                      key={m.id}
                      className={`flex ${m.isLocal ? "justify-end" : "justify-start"}`}
                    >
                      <div
                        className={`
                          max-w-[74%]
                          rounded-2xl
                          border border-white/10
                          bg-black/30
                          backdrop-blur-md
                          shadow
                          ${isNewest ? "px-3 py-2.5" : "px-2.5 py-2"}
                        `}
                        style={{
                          // Make older lines less obtrusive
                          opacity: isNewest ? 1 : 0.65,
                          transform: isNewest ? "scale(1)" : "scale(0.98)",
                          transformOrigin: m.isLocal ? "right bottom" : "left bottom",
                        }}
                      >
                        {/* Tiny header; make it basically invisible on older lines */}
                        <div
                          className="flex items-center justify-between gap-2 mb-0.5"
                          style={{ opacity: isNewest ? 0.7 : 0.35 }}
                        >
                          <span className="truncate text-[9px] text-white/70">
                            {m.isLocal ? "You" : m.fromName}
                          </span>
                          <span className="shrink-0 text-[9px] text-white/60">
                            {m.originalLang}→{m.translatedLang}
                          </span>
                        </div>

                        {/* Translated text (newest can be 3 lines, old lines 2) */}
                        <div
                          className={`${
                            isNewest ? "text-[13px]" : "text-[12px]"
                          } leading-snug text-white/95 overflow-hidden`}
                          style={{
                            display: "-webkit-box",
                            WebkitBoxOrient: "vertical",
                            WebkitLineClamp: isNewest ? 3 : 2,
                          }}
                        >
                          {m.translatedText}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Manual text input */}
          {showTextInput && (
            <form
              onSubmit={handleTextSubmit}
              className="pointer-events-auto absolute inset-x-0 bottom-24 flex justify-center"
            >
              <div className="flex gap-2 w-[92%] max-w-xl">
                <input
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                  placeholder="Type a quick caption…"
                  className="flex-1 rounded-full px-3 py-2 text-sm bg-black/70 border border-neutral-700 outline-none"
                />
                <button
                  type="submit"
                  className="px-3 py-2 rounded-full text-sm bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  Send
                </button>
              </div>
            </form>
          )}
        </main>

        {/* Floating bottom controls (like the top) */}
        <div className="fixed inset-x-0 bottom-0 z-40 pointer-events-none">
          {/* Left controls */}
          <div className="absolute left-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto flex items-center gap-2">
            <button
              onClick={toggleCamera}
              className={`${pillBase} ${camClass} ${
                roomType !== "video" ? "opacity-40 cursor-not-allowed" : ""
              } bg-black/25 backdrop-blur-md border-white/10`}
              disabled={roomType !== "video"}
            >
              {camOn ? "Cam" : "Cam Off"}
            </button>

            <button
              onClick={() => setShowTextInput((v) => !v)}
              className={`${pillBase} ${
                showTextInput
                  ? "bg-emerald-600/60 text-white border-emerald-400/30"
                  : "bg-black/25 text-white border-white/10"
              } backdrop-blur-md`}
            >
              Text
            </button>
          </div>

          {/* Right controls */}
          <div className="absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCcOn((v) => !v)}
              className={`
                px-3 py-1.5 rounded-full text-[11px]
                bg-black/25 backdrop-blur-md border border-white/10 shadow
                ${ccOn ? "text-white/95" : "text-white/55"}
              `}
              aria-pressed={ccOn}
              title="Toggle captions"
            >
              CC
            </button>

            <select
              value={captionLines}
              onChange={(e) => setCaptionLines(Number(e.target.value) || 3)}
              className="bg-black/25 backdrop-blur-md text-xs border border-white/10 rounded-full px-2 py-1 text-white/90 shadow"
              title="Caption lines"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </div>

          {/* Center PTT (lower, round, floating) */}
          <div className="absolute left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+6px)] pointer-events-auto">
            <button
              className={`
                w-[76px] h-[76px]
                rounded-full
                border
                shadow-xl
                backdrop-blur-md
                active:scale-[0.98]
                transition
                ${
                  micUiOn
                    ? "bg-emerald-600/65 border-emerald-300/30"
                    : "bg-red-600/55 border-red-300/30"
                }
              `}
              style={{ touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
              onPointerDown={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {}
                pttDown();
              }}
              onPointerUp={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {}
                pttUp();
              }}
              onPointerCancel={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                pttCancel();
              }}
              onClick={() => {
                if (isMobile) return;
                void toggleMic();
              }}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Push to talk"
            >
              <div className="flex flex-col items-center justify-center text-center leading-tight">
                <div className="text-[11px] text-white/90">
                  {isMobile ? (sttListening ? "Talking" : "Hold") : micOn ? "Mic On" : "Mic Off"}
                </div>
                <div className="text-[10px] text-white/70">
                  {isMobile ? (sttListening ? "Release" : "to talk") : "Click"}
                </div>
              </div>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}



