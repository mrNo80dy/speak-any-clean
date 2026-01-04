"use client";

import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  useLayoutEffect,
} from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { LANGUAGES } from "@/lib/languages";
import { useCallMode } from "@/hooks/useCallMode";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useAnySpeakTts } from "@/hooks/useAnySpeakTts";
import { useAnySpeakRealtime } from "@/hooks/useAnySpeakRealtime";
import { useAnySpeakRoomMedia } from "@/hooks/useAnySpeakRoomMedia";
import { useAnySpeakStt } from "@/hooks/useAnySpeakStt";
import { useAnySpeakMessages } from "@/hooks/useAnySpeakMessages";
import { useAnySpeakWebRtc, type AnySpeakPeer } from "@/hooks/useAnySpeakWebRtc";

// Types
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

/**
 * Adaptive video surface:
 * - If source & container have SAME orientation => cover (fills nicely)
 * - If MIXED orientation => contain (prevents ugly zoom/crop)
 */
function AdaptiveVideo({
  stream,
  isLocal = false,
  blurredBackdrop = true,
  className = "",
}: {
  stream: MediaStream | null;
  isLocal?: boolean;
  blurredBackdrop?: boolean;
  className?: string;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const vidRef = useRef<HTMLVideoElement | null>(null);
  const bgRef = useRef<HTMLVideoElement | null>(null);

  const [containerAspect, setContainerAspect] = useState<number>(16 / 9);
  const [videoAspect, setVideoAspect] = useState<number>(16 / 9);

  // measure container
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const a = r.height > 0 ? r.width / r.height : 16 / 9;
      setContainerAspect(a);
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // attach stream
  useEffect(() => {
    const v = vidRef.current;
    const b = bgRef.current;

    if (!stream) {
      if (v) v.srcObject = null;
      if (b) b.srcObject = null;
      return;
    }

    if (b && b.srcObject !== stream) {
      b.srcObject = stream;
      b.playsInline = true as any;
      b.muted = true;
      b.play().catch(() => {});
    }

    if (v && v.srcObject !== stream) {
      v.srcObject = stream;
      v.playsInline = true as any;
      v.muted = true; // local & remote video elements muted (raw audio handled by <audio data-remote>)
      v.play().catch(() => {});
    }
  }, [stream]);

  // detect video aspect from metadata
  useEffect(() => {
    const v = vidRef.current;
    if (!v) return;

    const onMeta = () => {
      const w = v.videoWidth || 16;
      const h = v.videoHeight || 9;
      const a = h > 0 ? w / h : 16 / 9;
      setVideoAspect(a);
    };

    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("resize", onMeta as any);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("resize", onMeta as any);
    };
  }, []);

  const containerPortrait = containerAspect < 1;
  const videoPortrait = videoAspect < 1;

  // Mixed orientation -> contain (fixes zoom/crop on PC<->phone)
  const mixedOrientation = containerPortrait !== videoPortrait;
  const objectFit = mixedOrientation ? "object-contain" : "object-cover";

  return (
    <div ref={wrapRef} className={`absolute inset-0 bg-black overflow-hidden ${className}`}>
      {blurredBackdrop && (
        <video
          ref={bgRef}
          autoPlay
          playsInline
          muted
          className="absolute inset-0 h-full w-full object-cover blur-xl scale-110 opacity-35"
        />
      )}

      <video
        ref={vidRef}
        autoPlay
        playsInline
        muted
        data-local={isLocal ? "1" : undefined}
        className={`absolute inset-0 h-full w-full ${objectFit}`}
      />
    </div>
  );
}

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";
  const debugKey = debugEnabled ? "debug" : "normal";

  const isMobile = useMemo(() => {
    if (typeof navigator === "undefined") return false;
    return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  }, []);

  const clientId = useMemo(() => {
    if (typeof window === "undefined") return "server";
    const existing = sessionStorage.getItem("clientId");
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem("clientId", id);
    return id;
  }, []);

  const peersRef = useRef<Map<string, Peer>>(new Map());
  const peerLabelsRef = useRef<Record<string, string>>({});
  const shouldSpeakTranslatedRef = useRef(false);
  const shouldMuteRawAudioRef = useRef(true);
  const userTouchedMicRef = useRef(false);

  const micOnRef = useRef(false);
  const micArmedRef = useRef(false);
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

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 250));
  };

  // captions/messages
  const { messages, pushMessage } = useAnySpeakMessages({ max: 30 });
  const [captionLines] = useState<number>(3);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [ccOn, setCcOn] = useState(false);

  // enforced room type
  const roomType: RoomType | null = roomInfo?.room_type ?? null;
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);

  const prejoinDone =
    roomType === "audio" ? true : roomType === "video" ? joinCamOn !== null : false;

  // final behavior
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
  const shouldSpeakTranslated =
    FINAL_AUTOSPEAK_TRANSLATED || (debugEnabled && debugSpeakTranslated);

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

  // load name
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("displayName");
    if (saved) setDisplayName(saved);
  }, []);

  // load room info
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

        if (safeType === "audio") setJoinCamOn(false);
      } catch (err) {
        log("room load error", { err: (err as Error).message });
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // local media hooks
  const enforcedModeParam: "audio" | "video" = roomType === "video" ? "video" : "audio";
  const participantCount = peerIds.length + 1;

  const { mode } = useCallMode({
    modeParam: enforcedModeParam,
    participantCount,
  });

  const localMedia = useLocalMedia({
    wantVideo: mode === "video",
    wantAudio: !isMobile, // mobile: no raw mic capture (STT uses mic)
  });

  const {
    localStreamRef,
    micOn,
    camOn,
    acquire,
    attachLocalVideo,
    setMicEnabled,
    setCamEnabled,
    stop,
  } = localMedia;

  const { beforeConnect, toggleCamera } = useAnySpeakRoomMedia({
    isMobile,
    roomType,
    joinCamOn,
    acquire: async () => await acquire(),
    localStreamRef,
    setCamEnabled,
    log,
  });

  // STT hook
  const {
    sttListening,
    sttArmedNotListening,
    sttStatus,
    sttErrorMessage,
    toggleMic,
    pttDown,
    pttUp,
    pttCancel,
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

  // peer helpers
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

  // ICE servers
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

  // WebRTC hook
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

  // kill raw audio on video/audio elements
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

  // send transcript
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

  // realtime
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
        if (!isMobile) setMicEnabled(false);
        micOnRef.current = false;
        stopAllStt(isMobile ? "auto-muted-3plus" : "auto-muted");
        log("auto-muted for 3+ participants", { total });
      }

      others.forEach((id) => {
        if (!peersRef.current.has(id)) {
          makeOffer(id, channel).catch(() => {});
        }
      });
    },
  });

  // text submit
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

  const micClass = micUiOn
    ? "bg-emerald-600/65 text-white border-emerald-300/30"
    : "bg-red-600/55 text-white border-red-300/30";

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
    } catch {
      try {
        window.location.href = "/";
      } catch {}
    }
  };

  // ---------- PiP (self-view) ----------
  const pipRef = useRef<HTMLDivElement | null>(null);
  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);
  const [pipVisible, setPipVisible] = useState(true);
  const pipHideTimerRef = useRef<number | null>(null);
  const pipDraggingRef = useRef(false);
  const pipDragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const clearPipTimer = () => {
    if (pipHideTimerRef.current) {
      window.clearTimeout(pipHideTimerRef.current);
      pipHideTimerRef.current = null;
    }
  };
  const schedulePipHide = () => {
    clearPipTimer();
    pipHideTimerRef.current = window.setTimeout(() => setPipVisible(false), 2500);
  };
  const pipShowNow = () => {
    setPipVisible(true);
    schedulePipHide();
  };

  // initial PiP position:
  // - mobile: top-left (below top pills)
  // - desktop: bottom-right
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (pipPos) return;
    if (peerIds.length !== 1) return;
    const el = pipRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const w = rect.width || 160;
    const h = rect.height || 96;

    const pad = 12;
    const topBar = 68; // clears CC/Share/Online/End
    const bottomDock = 120;

    const x = isMobile ? pad : Math.max(pad, window.innerWidth - w - pad);
    const y = isMobile ? topBar : Math.max(pad, window.innerHeight - h - bottomDock);

    setPipPos({ x, y });
    setPipVisible(true);
    schedulePipHide();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerIds.length, isMobile]);

  useEffect(() => {
    return () => clearPipTimer();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!pipPos) return;

    const onResize = () => {
      const el = pipRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const pad = 8;
      const topBar = 68;
      const bottomDock = 120;

      const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
      const maxY = Math.max(topBar, window.innerHeight - rect.height - bottomDock);

      setPipPos((p) =>
        p
          ? {
              x: Math.min(Math.max(p.x, pad), maxX),
              y: Math.min(Math.max(p.y, topBar), maxY),
            }
          : p
      );
    };

    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [pipPos]);

  const pipOnPointerDown = (e: React.PointerEvent) => {
    pipShowNow();
    if (!pipPos) return;
    pipDraggingRef.current = true;
    clearPipTimer();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {}
    pipDragOffsetRef.current = { dx: e.clientX - pipPos.x, dy: e.clientY - pipPos.y };
  };

  const pipOnPointerMove = (e: React.PointerEvent) => {
    if (!pipDraggingRef.current) return;
    const el = pipRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const pad = 8;
    const topBar = 68;
    const bottomDock = 120;

    const maxX = Math.max(pad, window.innerWidth - rect.width - pad);
    const maxY = Math.max(topBar, window.innerHeight - rect.height - bottomDock);

    const x = e.clientX - pipDragOffsetRef.current.dx;
    const y = e.clientY - pipDragOffsetRef.current.dy;

    setPipPos({
      x: Math.min(Math.max(x, pad), maxX),
      y: Math.min(Math.max(y, topBar), maxY),
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

  // desktop mic toggle (fix: “no way to turn on MIC on PC”)
  const toggleDesktopMic = () => {
    if (isMobile) return;
    userTouchedMicRef.current = true;
    setMicEnabled(!micOn);
  };

  // effective caption lines
  const effectiveCaptionLines = Math.max(1, captionLines || 3);

  // layout buckets
  const showOneOnOne = peerIds.length === 1 && !!firstRemoteId;
  const showGrid = totalParticipants >= 2 && totalParticipants <= 4;
  const showSpotlight = totalParticipants >= 5;

  return (
    <div className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="relative h-full w-full overflow-hidden">
        {/* Joiner overlay for VIDEO rooms: choose cam ON/OFF */}
        {roomType === "video" && joinCamOn === null && (
          <div className="absolute inset-0 z-50">
            <div className="absolute inset-0">
              {localStreamRef.current ? (
                <div className="absolute inset-0 opacity-60">
                  <AdaptiveVideo stream={localStreamRef.current} isLocal blurredBackdrop />
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
                  className="w-[96px] h-[96px] rounded-full flex items-center justify-center border border-white/10 bg-emerald-600/75 hover:bg-emerald-600 active:scale-[0.97] shadow-2xl backdrop-blur-md text-white text-3xl transition"
                  title="Camera on"
                  aria-label="Camera on"
                >
                  📷
                </button>

                <button
                  type="button"
                  onClick={() => setJoinCamOn(false)}
                  className="w-[96px] h-[96px] rounded-full flex items-center justify-center border border-white/10 bg-white/10 hover:bg-white/15 active:scale-[0.97] shadow-2xl backdrop-blur-md text-white text-3xl transition"
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
            {/* 0 peers: show local */}
            {peerIds.length === 0 && (
              <div className="relative h-full w-full bg-neutral-900">
                <AdaptiveVideo stream={localStreamRef.current} isLocal blurredBackdrop />
              </div>
            )}

            {/* 1 peer: remote full, local PiP */}
            {showOneOnOne && firstRemoteId && (
              <div className="relative h-full w-full bg-neutral-900">
                <AdaptiveVideo stream={firstRemoteStream} blurredBackdrop />
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

                {/* Local PiP */}
                {roomType === "video" && (
                  <div
                    ref={pipRef}
                    className="pointer-events-auto absolute z-30 rounded-2xl overflow-hidden border border-white/10 shadow-xl bg-black"
                    style={{
                      left: pipPos?.x ?? 12,
                      top: pipPos?.y ?? 68,
                      // Let the video itself decide fit; we just bound the box.
                      width: isMobile ? 140 : 160,
                      height: isMobile ? 140 : 96, // square-ish on mobile (AdaptiveVideo will contain/cover based on orientation)
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
                      <div className="relative h-full w-full">
                        <AdaptiveVideo stream={localStreamRef.current} isLocal blurredBackdrop={false} />
                      </div>
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-[11px] text-white/80 bg-black/60">
                        Camera off
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 2-4 participants: grid */}
            {showGrid && (
              <div className="h-full w-full p-2 md:p-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                {/* Local tile (only in video rooms) */}
                {roomType === "video" && (
                  <div className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0">
                    <AdaptiveVideo stream={localStreamRef.current} isLocal blurredBackdrop />
                    <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded">
                      You
                    </div>
                  </div>
                )}

                {peerIds.map((pid) => (
                  <div
                    key={pid}
                    className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0"
                  >
                    <AdaptiveVideo stream={peerStreams[pid] ?? null} blurredBackdrop />
                    <audio
                      data-remote
                      autoPlay
                      ref={(el) => {
                        const stream = peerStreams[pid];
                        if (!el || !stream) return;
                        if (el.srcObject !== stream) el.srcObject = stream;
                      }}
                    />
                    <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded">
                      {peerLabels[pid] ?? pid.slice(0, 8)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 5+ spotlight */}
            {showSpotlight && (
              <div className="flex flex-col h-full w-full">
                <div className="relative flex-1 bg-neutral-900 rounded-none md:rounded-2xl overflow-hidden m-0 md:m-2">
                  {spotlightId === "local" ? (
                    <AdaptiveVideo stream={localStreamRef.current} isLocal blurredBackdrop />
                  ) : (
                    <>
                      <AdaptiveVideo stream={peerStreams[spotlightId] ?? null} blurredBackdrop />
                      <audio
                        data-remote
                        autoPlay
                        ref={(el) => {
                          const stream = peerStreams[spotlightId];
                          if (!el || !stream) return;
                          if (el.srcObject !== stream) el.srcObject = stream;
                        }}
                      />
                      <div className="absolute bottom-3 left-3 text-xs bg-neutral-900/70 px-2 py-1 rounded">
                        {peerLabels[spotlightId] ?? spotlightId.slice(0, 8)}
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
                        <div className="absolute bottom-1 left-1 text-[10px] bg-neutral-900/70 px-1.5 py-0.5 rounded">
                          {peerLabels[pid] ?? pid.slice(0, 8)}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Captions */}
          {ccOn && messages.length > 0 && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30">
              <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-black/55 via-black/15 to-transparent" />
              <div
                className="relative flex flex-col gap-1.5 px-3"
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
                          <span className="truncate text-[9px] text-white/70">
                            {m.isLocal ? "You" : m.fromName}
                          </span>
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

        {/* Bottom controls */}
        <div className="fixed inset-0 z-50 pointer-events-none">
          {/* Desktop MIC toggle (bottom left) */}
          {!isMobile && (
            <div className="absolute left-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto">
              <button
                onClick={toggleDesktopMic}
                className={`${pillBase} ${micClass} bg-black/25 backdrop-blur-md border-white/10 active:scale-[0.98] transition`}
                title="Microphone"
              >
                {micOn ? "🎙️" : "🎙️✕"}
              </button>
            </div>
          )}

          {/* Camera toggle (bottom right) */}
          <div className="absolute right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto">
            <button
              onClick={toggleCamera}
              className={`${pillBase} ${camClass} ${
                roomType !== "video" ? "opacity-40 cursor-not-allowed" : ""
              } bg-black/25 backdrop-blur-md border-white/10`}
              disabled={roomType !== "video"}
              title="Camera"
            >
              {camOn ? "📷" : "📷✕"}
            </button>
          </div>

          {/* Mobile PTT (unchanged behavior) */}
          {isMobile && (
            <div className="fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto">
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
                  e.preventDefault();
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  // hold to talk
                  window.setTimeout(() => {
                    pttDown();
                  }, 140);
                }}
                onPointerUp={(e) => {
                  e.preventDefault();
                  try {
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  } catch {}
                  pttUp();
                }}
                onPointerCancel={(e) => {
                  e.preventDefault();
                  pttCancel();
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

          {/* Small “Text” toggle (optional quick access) */}
          <div className="absolute left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-auto">
            <button
              onClick={() => setShowTextInput((v) => !v)}
              className="px-4 py-1 rounded-full text-xs bg-black/25 backdrop-blur-md border border-white/10 text-white/90 shadow active:scale-[0.98] transition"
              title="Text"
            >
              {showTextInput ? "Text ✕" : "Text"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
