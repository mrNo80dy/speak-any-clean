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
type RealtimeSubscribeStatus = "SUBSCRIBED" | "CLOSED" | "TIMED_OUT" | "CHANNEL_ERROR";

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

function FullBleedVideo({
  stream,
  isLocal = false,
}: {
  stream: MediaStream | null;
  isLocal?: boolean;
}) {
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const fgRef = useRef<HTMLVideoElement | null>(null);
  const cloneRef = useRef<MediaStream | null>(null);

  // ✅ Stream aspect ratio (w/h) so we can adapt crop for PC↔Mobile cases
  const [streamAspect, setStreamAspect] = useState<number | null>(null);

  // ✅ Final decision: foreground uses cover or contain
  const [fit, setFit] = useState<"cover" | "contain">("contain");

  // Attach streams
  useEffect(() => {
    const s = stream || null;

    const fg = fgRef.current;
    const bg = bgRef.current;

    if (!s) {
      if (fg) fg.srcObject = null;
      if (bg) bg.srcObject = null;
      return;
    }

    // Clone for blurred background layer
    const tracks = s.getTracks();
    if (!cloneRef.current || cloneRef.current.getTracks().length !== tracks.length) {
      cloneRef.current = new MediaStream(tracks);
    }

    if (bg && bg.srcObject !== cloneRef.current) {
      bg.srcObject = cloneRef.current;
      bg.playsInline = true as any;
      bg.muted = true;
      bg.play().catch(() => {});
    }

    if (fg && fg.srcObject !== s) {
      fg.srcObject = s;
      fg.playsInline = true as any;
      fg.muted = true;
      fg.play().catch(() => {});
    }
  }, [stream]);

  // Measure actual video dimensions once metadata arrives
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const onMeta = () => {
      const w = fg.videoWidth || 0;
      const h = fg.videoHeight || 0;
      if (w > 0 && h > 0) setStreamAspect(w / h);
    };

    fg.addEventListener("loadedmetadata", onMeta);
    // Some browsers fire resize when dimensions settle
    fg.addEventListener("resize", onMeta as any);

    return () => {
      fg.removeEventListener("loadedmetadata", onMeta);
      fg.removeEventListener("resize", onMeta as any);
    };
  }, []);

  // ✅ Fit policy:
  // - Mobile portrait viewer + landscape stream (PC camera) => CONTAIN (less crop)
  // - Mobile portrait viewer + portrait stream (mobile camera) => COVER (fills nicely)
  // - Everything else => CONTAIN (clean framing)
  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;

    const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    const update = () => {
      const vw = window.innerWidth || 360;
      const vh = window.innerHeight || 640;
      const viewerAspect = vw / vh;
      const portraitViewer = viewerAspect < 1;

      const sA = streamAspect ?? 1;
      const landscapeStream = sA > 1.1;

      if (isMobileUa && portraitViewer) {
        setFit(landscapeStream ? "contain" : "cover");
        return;
      }

      setFit("contain");
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [streamAspect]);

  return (
    <div className="absolute inset-0 bg-black overflow-hidden">
      {/* Blurred fill background */}
      <video
        ref={bgRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover blur-xl scale-110 opacity-40"
      />

      {/* Foreground: adaptive fit */}
      <video
        ref={fgRef}
        autoPlay
        playsInline
        muted
        data-local={isLocal ? "1" : undefined}
        className={`absolute inset-0 h-full w-full ${
          fit === "cover" ? "object-cover" : "object-contain"
        }`}
      />
    </div>
  );
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

  // ---- Mobile PTT positioning (dockable) ----
  type PttDock = "bottom" | "left" | "right";
  const [pttDock, setPttDock] = useState<PttDock>("bottom");
  const [pttT, setPttT] = useState<number>(0); // 0..1

  const pttDockRef = useRef<PttDock>("bottom");
  const pttTRef = useRef<number>(0);

  useEffect(() => {
    pttDockRef.current = pttDock;
  }, [pttDock]);
  useEffect(() => {
    pttTRef.current = pttT;
  }, [pttT]);

  const pttDragRef = useRef<{
    pointerId: number | null;
    startX: number;
    startY: number;
    moved: boolean;
    dragging: boolean;
    startedPtt: boolean;
    holdTimer: any;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    dragging: false,
    startedPtt: false,
    holdTimer: null,
  });

  useEffect(() => {
    if (!isMobile) return;
    try {
      const saved = localStorage.getItem("anyspeak_ptt_dock_v1");
      if (saved) {
        const parsed = JSON.parse(saved);
        const d = parsed?.dock as PttDock | undefined;
        const t = parsed?.t as number | undefined;
        const okDock = d === "bottom" || d === "left" || d === "right";
        if (okDock && typeof t === "number") {
          setPttDock(d as PttDock);
          setPttT(Math.min(1, Math.max(0, t)));
          return;
        }
      }
    } catch {}

    // Default: bottom-left-ish
    setPttDock("bottom");
    setPttT(0);
  }, [isMobile]);

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

  // Set an initial position once we know the PiP size.
  // ✅ Mobile: start top-left (below the top pills).
  // ✅ Desktop: bottom-right-ish.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pipPos) return;
    if (peerIds.length !== 1) return;

    const el = pipRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 96;

    const pad = 16;

    if (isMobile) {
      const topPad = 70; // clears top pills + safe area-ish
      const x = pad;
      const y = Math.max(pad, topPad);
      setPipPos({ x, y });
    } else {
      const dock = 120;
      const x = Math.max(pad, window.innerWidth - w - pad);
      const y = Math.max(pad, window.innerHeight - h - dock);
      setPipPos({ x, y });
    }

    setPipVisible(true);
    schedulePipHide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerIds.length, isMobile]);

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
      setPipPos((p) =>
        p
          ? {
              x: Math.min(Math.max(p.x, pad), maxX),
              y: Math.min(Math.max(p.y, pad), maxY),
            }
          : p
      );
    };

    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [pipPos]);

  const pipShowNow = () => {
    setPipVisible(true);
    schedulePipHide();
  };

  const pipOnPointerDown = (e: React.PointerEvent) => {
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
      pipShowNow();
      return;
    }
    pipDraggingRef.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
    schedulePipHide();
  };

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
  const [ccOn, setCcOn] = useState(false);

  // ✅ Enforced room mode (from DB)
  const roomType: RoomType | null = roomInfo?.room_type ?? null;

  // ✅ Joiner camera choice for VIDEO rooms
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);

  const prejoinDone = roomType === "audio" ? true : roomType === "video" ? joinCamOn !== null : false;

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 250));
  };

  // ---------- FINAL vs DEBUG behavior ----------
  const FINAL_MUTE_RAW_AUDIO = true;
  const FINAL_AUTOSPEAK_TRANSLATED = true;

  const [debugHearRawAudio, setDebugHearRawAudio] = useState(false);
  const [debugSpeakTranslated, setDebugSpeakTranslated] = useState(false);

  const initialSpeak = useMemo(() => {
    if (typeof navigator === "undefined") return "en-US";
    return pickSupportedLang(navigator.language || "en-US");
  }, []);
  const [speakLang, setSpeakLang] = useState<string>(initialSpeak);
  const speakLangRef = useRef<string>(initialSpeak);

  const initialTarget = useMemo(() => {
    if (typeof navigator === "undefined") return "en-US";
    return pickSupportedLang(navigator.language || "en-US");
  }, []);
  const [targetLang, setTargetLang] = useState<string>(initialTarget);
  const targetLangRef = useRef<string>(initialTarget);

  const { speakText, unlockTts } = useAnySpeakTts({
    getLang: () => targetLangRef.current || "en-US",
    onLog: (m, data) => log(m, data ?? {}),
  });

  const shouldMuteRawAudio = FINAL_MUTE_RAW_AUDIO && !debugHearRawAudio;
  const shouldSpeakTranslated = FINAL_AUTOSPEAK_TRANSLATED || (debugEnabled && debugSpeakTranslated);

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
    shouldSpeakTranslatedRef.current = FINAL_AUTOSPEAK_TRANSLATED || (debugEnabled && debugSpeakTranslated);
  }, [debugEnabled, debugSpeakTranslated]);

  useEffect(() => {
    displayNameRef.current = displayName || "You";
  }, [displayName]);

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
        const { data, error } = await supabase.from("rooms").select("code, room_type").eq("id", roomId).maybeSingle();

        if (error) {
          log("room load error", { message: error.message });
          return;
        }

        const dbType = (data?.room_type || "audio") as RoomType;
        const safeType: RoomType = dbType === "video" ? "video" : "audio";

        setRoomInfo({ code: (data?.code ?? null) as any, room_type: safeType });
        log("room loaded", { safeType });

        if (safeType === "audio") {
          setJoinCamOn(false);
        }
      } catch (err) {
        log("room load error", { err: (err as Error).message });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // ✅ STT send helper
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

  const { localStreamRef, micOn, camOn, acquire, attachLocalVideo, setMicEnabled, setCamEnabled, stop } = localMedia;

  const { beforeConnect, toggleCamera } = useAnySpeakRoomMedia({
    isMobile,
    roomType,
    joinCamOn,
    acquire: async () => {
      return await acquire();
    },
    localStreamRef,
    setCamEnabled,
    log,
  });

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

  useEffect(() => {
    if (turnEnabled) {
      log("TURN enabled", { turnUrlsCount });
    } else {
      log("TURN not configured", turnMissing);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { makeOffer, handleOffer, handleAnswer, handleIce, clearPendingIce } = useAnySpeakWebRtc({
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
      if ((v as any).dataset?.local === "1") return;
      v.muted = !allowRaw;
      v.volume = allowRaw ? 1 : 0;
      if (allowRaw) v.play().catch(() => {});
    });
  }, [shouldMuteRawAudio, peerStreams, peerIds]);

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

      const fromName = name ?? peerLabelsRef.current[from] ?? from.slice(0, 8) ?? "Guest";

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

  const camClass = camOn
    ? "bg-neutral-100 text-neutral-900 border-neutral-300"
    : "bg-red-900/80 text-red-100 border-red-700";

  const effectiveCaptionLines = Math.max(1, captionLines || 3);

  const handleEndCall = async () => {
    try {
      stopAllStt("end_call");
    } catch {}
    try {
      teardownPeers("end_call");
    } catch {}
    try {
      stop();
    } catch {}
    try {
      router.push("/");
    } catch {}
  };

  // ---- PTT dock layout helpers (mobile) ----------------------
  const getPttLayout = () => {
    const w = typeof window !== "undefined" ? window.innerWidth || 360 : 360;
    const h = typeof window !== "undefined" ? window.innerHeight || 640 : 640;
    const size = 76;
    const margin = 12;
    const edgeZone = 56;

    const xLeft = margin;
    const xCenter = Math.round((w - size) / 2);
    const xRight = Math.max(margin, w - size - margin);

    const topPad = 92;
    const bottomPad = showTextInput ? 210 : 150;
    const minY = topPad;
    const maxY = Math.max(minY, h - bottomPad - size);

    return { w, h, size, margin, edgeZone, xLeft, xCenter, xRight, minY, maxY };
  };

  const pttPx = useMemo(() => {
    if (!isMobile) return { left: 12, top: 0, dock: "bottom" as const };
    const { xLeft, xRight, minY, maxY } = getPttLayout();

    const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
    const t = clamp01(pttT);

    if (pttDock === "bottom") {
      const left = Math.round(xLeft + (xRight - xLeft) * t);
      return { dock: "bottom" as const, left, top: 0 };
    }
    const top = Math.round(minY + (maxY - minY) * t);
    return { dock: pttDock as "left" | "right", left: 0, top };
  }, [isMobile, pttDock, pttT, showTextInput]);

  // ---- Render -----------------------------------------------
  return (
    <div className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="relative h-full w-full overflow-hidden">
        {/* ✅ Joiner overlay */}
        {roomType === "video" && joinCamOn === null && (
          <div className="absolute inset-0 z-50">
            <div className="absolute inset-0">
              {localStreamRef.current ? (
                <div className="absolute inset-0 opacity-60">
                  <FullBleedVideo stream={localStreamRef.current} isLocal />
                </div>
              ) : (
                <div className="absolute inset-0 bg-black" />
              )}
              <div className="absolute inset-0 bg-black/70" />
            </div>

            <div
              className="relative z-10 flex h-full w-full items-center justify-center"
              onClick={() => setJoinCamOn(false)}
            >
              <div className="flex gap-6" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => setJoinCamOn(true)}
                  className="
                    w-[96px] h-[96px]
                    rounded-full
                    flex items-center justify-center
                    border border-white/10
                    bg-emerald-600/75
                    hover:bg-emerald-600
                    active:scale-[0.97]
                    shadow-2xl
                    backdrop-blur-md
                    text-white text-3xl
                    transition
                  "
                  title="Camera on"
                  aria-label="Camera on"
                >
                  📷
                </button>

                <button
                  type="button"
                  onClick={() => setJoinCamOn(false)}
                  className="
                    w-[96px] h-[96px]
                    rounded-full
                    flex items-center justify-center
                    border border-white/10
                    bg-white/10
                    hover:bg-white/15
                    active:scale-[0.97]
                    shadow-2xl
                    backdrop-blur-md
                    text-white text-3xl
                    transition
                  "
                  title="Camera off"
                  aria-label="Camera off"
                >
                  📷✕
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Top floating controls */}
        <header className="absolute top-2 left-2 right-2 z-20 pointer-events-none">
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setCcOn((v) => !v)}
              className={`pointer-events-auto px-3 py-1.5 rounded-full bg-black/25 backdrop-blur-md border border-white/10 text-[11px] text-white/90 shadow ${
                ccOn ? "ring-1 ring-white/20" : "opacity-80"
              }`}
              title="Closed Captions"
            >
              CC
            </button>

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

            <button
              type="button"
              onClick={handleEndCall}
              className="pointer-events-auto px-3 py-1.5 rounded-full bg-red-600/45 backdrop-blur-md border border-white/10 text-[11px] text-white/95 shadow active:scale-[0.98] transition"
              title="End call"
            >
              📴
            </button>
          </div>
        </header>

        <main className="absolute inset-0 pt-0 md:pt-14">
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
                <FullBleedVideo stream={localStreamRef.current} isLocal />
              </div>
            )}

            {peerIds.length === 1 && firstRemoteId && (
              <div className="relative h-full w-full bg-neutral-900">
                <FullBleedVideo stream={firstRemoteStream} />
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

                {/* Local self-view (PiP): movable + auto-fade */}
                {roomType === "video" && (
                  <div
                    ref={pipRef}
                    className="pointer-events-auto absolute z-30 rounded-2xl overflow-hidden border border-white/10 shadow-xl bg-black"
                    style={{
                      left: pipPos?.x ?? 16,
                      top: pipPos?.y ?? 70,
                      width: 160,
                      height: 96,
                      opacity: pipVisible ? 1 : 0.25,
                      transition: "opacity 250ms ease",
                      touchAction: "none",
                      userSelect: "none",
                      WebkitUserSelect: "none",
                    }}
                    onPointerDown={pipOnPointerDown}
                    onPointerMove={pipOnPointerMove}
                    onPointerUp={pipOnPointerUpOrCancel}
                    onPointerCancel={pipOnPointerUpOrCancel}
                    onClick={() => pipShowNow()}
                    title="Your camera"
                    aria-label="Your camera"
                  >
                    {camOn ? (
                      <FullBleedVideo stream={localStreamRef.current} isLocal />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-[11px] text-white/80 bg-black/60">
                        Camera off
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* NOTE: your 2–4 participant layout was not included in what you pasted,
                so I did NOT invent a new grid here. Keeping exactly what you gave. */}

            {totalParticipants >= 5 && (
              <div className="flex flex-col h-full w-full">
                <div className="relative flex-1 bg-neutral-900 rounded-none md:rounded-2xl overflow-hidden m-0 md:m-2">
                  {spotlightId === "local" ? (
                    <FullBleedVideo stream={localStreamRef.current} isLocal />
                  ) : (
                    <>
                      <FullBleedVideo stream={peerStreams[spotlightId] ?? null} />
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
                        className="h-full w-full object-contain bg-black"
                      />
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

          {/* Captions overlay */}
          {ccOn && messages.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />

              <div
                className="relative flex flex-col gap-1.5 px-3 pb-[calc(env(safe-area-inset-bottom)+10px)]"
                style={{
                  paddingBottom: showTextInput
                    ? "calc(env(safe-area-inset-bottom) + 148px)"
                    : "calc(env(safe-area-inset-bottom) + 108px)",
                }}
              >
                {messages.slice(-effectiveCaptionLines).map((m, idx, arr) => {
                  const isNewest = idx === arr.length - 1;

                  return (
                    <div key={m.id} className={`flex ${m.isLocal ? "justify-end" : "justify-start"}`}>
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
                          opacity: isNewest ? 1 : 0.65,
                          transform: isNewest ? "scale(1)" : "scale(0.98)",
                          transformOrigin: m.isLocal ? "right bottom" : "left bottom",
                        }}
                      >
                        <div
                          className="flex items-center justify-between gap-2 mb-0.5"
                          style={{ opacity: isNewest ? 0.7 : 0.35 }}
                        >
                          <span className="truncate text-[9px] text-white/70">{m.isLocal ? "You" : m.fromName}</span>
                          <span className="shrink-0 text-[9px] text-white/60">
                            {m.originalLang}→{m.translatedLang}
                          </span>
                        </div>

                        <div
                          className={`${isNewest ? "text-[13px]" : "text-[12px]"} leading-snug text-white/95 overflow-hidden`}
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
            <form onSubmit={handleTextSubmit} className="pointer-events-auto absolute inset-x-0 bottom-24 flex justify-center">
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

        {/* Controls overlay (camera + PTT) */}
        <div className="fixed inset-0 z-50 pointer-events-none">
          {/* Camera toggle (bottom right) */}
          <div className="absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto">
            <button
              onClick={toggleCamera}
              className={`${pillBase} ${camClass} ${roomType !== "video" ? "opacity-40 cursor-not-allowed" : ""} bg-black/25 backdrop-blur-md border-white/10`}
              disabled={roomType !== "video"}
              title="Camera"
            >
              {camOn ? "📷" : "📷✕"}
            </button>
          </div>

          {/* PTT (mobile, dockable) */}
          {isMobile && (
            <div
              className="fixed pointer-events-auto"
              style={
                pttPx.dock === "bottom"
                  ? { left: pttPx.left, bottom: "calc(env(safe-area-inset-bottom) + 12px)" }
                  : pttPx.dock === "left"
                  ? { left: 12, top: pttPx.top }
                  : { right: 12, top: pttPx.top }
              }
            >
              <button
                className={`
                  w-[76px] h-[76px]
                  rounded-full
                  border
                  shadow-xl
                  backdrop-blur-md
                  active:scale-[0.98]
                  transition
                  ${micUiOn ? "bg-emerald-600/65 border-emerald-300/30" : "bg-red-600/55 border-red-300/30"}
                `}
                style={{ touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
                onPointerDown={(e) => {
                  if (!isMobile) return;
                  e.preventDefault();
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  const d = pttDragRef.current;
                  d.pointerId = e.pointerId;
                  d.startX = e.clientX;
                  d.startY = e.clientY;
                  d.moved = false;
                  d.dragging = false;
                  d.startedPtt = false;

                  if (d.holdTimer) {
                    clearTimeout(d.holdTimer);
                    d.holdTimer = null;
                  }

                  d.holdTimer = setTimeout(() => {
                    if (!pttDragRef.current.moved) {
                      pttDown();
                      pttDragRef.current.startedPtt = true;
                    }
                  }, 140);
                }}
                onPointerMove={(e) => {
                  if (!isMobile) return;
                  const d = pttDragRef.current;
                  if (d.pointerId !== e.pointerId) return;

                  const dx = e.clientX - d.startX;
                  const dy = e.clientY - d.startY;
                  const dist = Math.hypot(dx, dy);

                  if (!d.moved && dist > 8) {
                    d.moved = true;
                    d.dragging = true;
                    if (d.holdTimer) {
                      clearTimeout(d.holdTimer);
                      d.holdTimer = null;
                    }
                    if (d.startedPtt) {
                      pttCancel();
                      d.startedPtt = false;
                    }
                  }

                  if (!d.dragging) return;

                  const { w, size, edgeZone, xLeft, xRight, minY, maxY } = getPttLayout();

                  const nextDock =
                    e.clientX <= edgeZone ? "left" : e.clientX >= w - size - edgeZone ? "right" : "bottom";

                  if (nextDock !== pttDockRef.current) {
                    setPttDock(nextDock as any);
                    pttDockRef.current = nextDock as any;
                  }

                  if (nextDock === "bottom") {
                    const centerX = e.clientX - size / 2;
                    const t = (centerX - xLeft) / (xRight - xLeft || 1);
                    setPttT(Math.min(1, Math.max(0, t)));
                  } else {
                    const centerY = e.clientY - size / 2;
                    const t = (centerY - minY) / (maxY - minY || 1);
                    setPttT(Math.min(1, Math.max(0, t)));
                  }
                }}
                onPointerUp={(e) => {
                  if (!isMobile) return;
                  e.preventDefault();
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  } catch {}

                  const d = pttDragRef.current;
                  if (d.holdTimer) {
                    clearTimeout(d.holdTimer);
                    d.holdTimer = null;
                  }

                  if (d.dragging) {
                    const { xLeft, xCenter, xRight } = getPttLayout();

                    if (pttDockRef.current === "bottom") {
                      const x = pttPx.left;
                      const candidates = [xLeft, xCenter, xRight];
                      let best = candidates[0];
                      let bestDist = Math.abs(x - best);
                      for (const c of candidates.slice(1)) {
                        const dd = Math.abs(x - c);
                        if (dd < bestDist) {
                          bestDist = dd;
                          best = c;
                        }
                      }

                      const newT =
                        best === xLeft
                          ? 0
                          : best === xRight
                          ? 1
                          : (xCenter - xLeft) / (xRight - xLeft || 1);

                      setPttT(newT);
                      try {
                        localStorage.setItem("anyspeak_ptt_dock_v1", JSON.stringify({ dock: "bottom", t: newT }));
                      } catch {}
                    } else {
                      try {
                        localStorage.setItem(
                          "anyspeak_ptt_dock_v1",
                          JSON.stringify({ dock: pttDockRef.current, t: pttTRef.current })
                        );
                      } catch {}
                    }
                  } else if (d.startedPtt) {
                    pttUp();
                  }

                  d.pointerId = null;
                  d.dragging = false;
                  d.moved = false;
                  d.startedPtt = false;
                }}
                onPointerCancel={(e) => {
                  if (!isMobile) return;
                  e.preventDefault();
                  const d = pttDragRef.current;
                  if (d.holdTimer) {
                    clearTimeout(d.holdTimer);
                    d.holdTimer = null;
                  }
                  if (d.startedPtt) {
                    pttCancel();
                  }
                  d.pointerId = null;
                  d.dragging = false;
                  d.moved = false;
                  d.startedPtt = false;
                }}
                onClick={() => {
                  if (isMobile) return;
                  void toggleMic();
                }}
                onContextMenu={(e) => e.preventDefault()}
                aria-label="Push to talk"
                title="Push to talk"
              >
                <div className="flex items-center justify-center text-center leading-tight">
                  <div className="text-2xl">🎙️</div>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
