"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type React from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { LANGUAGES } from "@/lib/languages";
import { useCallMode } from "@/hooks/useCallMode";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useAnySpeakTts } from "@/hooks/useAnySpeakTts";
import { useAnySpeakRealtime } from "@/hooks/useAnySpeakRealtime";
import { useCamera } from "@/hooks/useCamera";
import { useAnySpeakStt } from "@/hooks/useAnySpeakStt";
import { useAnySpeakMessages } from "@/hooks/useAnySpeakMessages";
import { useAnySpeakWebRtc, type AnySpeakPeer } from "@/hooks/useAnySpeakWebRtc";
import FullBleedVideo from "@/components/FullBleedVideo";
import { useHudController } from "@/hooks/useHudController";
import { TopHud } from "@/components/TopHud";
import { BottomRightHud } from "@/components/BottomRightHud";
import { PipView } from "@/components/PipView";
import { PttButton } from "@/components/PttButton";
import { HudWakeZones } from "@/components/HudWakeZones";

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

type PttDock = "bottom" | "left" | "right";

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

/**
 * Smarter video framing:
 * - Desktop: ALWAYS contain (no aggressive crop/zoom).
 * - Mobile portrait:
 *   - portrait stream -> cover (fills screen nicely)
 *   - landscape stream -> contain (reduces “zoomed in / chopped head” when PC->phone)
 * - Mobile landscape: behave like desktop (contain).
 */
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

// Mobile HUD: visible on entry, fades after a while, returns when top area/video touched.
  // HUD visibility (split): Top HUD, Bottom-right HUD, and PiP controls are independent.
  const [topHudVisible, setTopHudVisible] = useState(true);
  const [brHudVisible, setBrHudVisible] = useState(true);
  const [pipHudVisible, setPipHudVisible] = useState(false);

  const topHudTimerRef = useRef<number | null>(null);
  const brHudTimerRef = useRef<number | null>(null);
  const pipHudTimerRef = useRef<number | null>(null);

  const showTopHudFor = useCallback((ms: number) => {
    if (topHudTimerRef.current) window.clearTimeout(topHudTimerRef.current);
    setTopHudVisible(true);
    topHudTimerRef.current = window.setTimeout(() => setTopHudVisible(false), ms);
  }, []);

  const showBrHudFor = useCallback((ms: number) => {
    if (brHudTimerRef.current) window.clearTimeout(brHudTimerRef.current);
    setBrHudVisible(true);
    brHudTimerRef.current = window.setTimeout(() => setBrHudVisible(false), ms);
  }, []);

  const showPipHudFor = useCallback((ms: number) => {
    if (pipHudTimerRef.current) window.clearTimeout(pipHudTimerRef.current);
    setPipHudVisible(true);
    pipHudTimerRef.current = window.setTimeout(() => setPipHudVisible(false), ms);
  }, []);

  const showTopHudInitial = useCallback(() => showTopHudFor(8000), [showTopHudFor]);
  const showBrHudInitial = useCallback(() => showBrHudFor(8000), [showBrHudFor]);
  const showTopHudAfterInteraction = useCallback(() => showTopHudFor(3000), [showTopHudFor]);
  const showBrHudAfterInteraction = useCallback(() => showBrHudFor(3000), [showBrHudFor]);
  const showPipHudAfterInteraction = useCallback(() => showPipHudFor(3000), [showPipHudFor]);

  useEffect(() => {
    showTopHudInitial();
    showBrHudInitial();
    return () => {
      if (topHudTimerRef.current) window.clearTimeout(topHudTimerRef.current);
      if (brHudTimerRef.current) window.clearTimeout(brHudTimerRef.current);
      if (pipHudTimerRef.current) window.clearTimeout(pipHudTimerRef.current);
    };
  }, [showTopHudInitial, showBrHudInitial]);
  
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
  const shouldSpeakTranslatedRef = useRef(false);
  const shouldMuteRawAudioRef = useRef(true);

  // Track if user manually touched mic so we don't "helpfully" auto-mute later
  const userTouchedMicRef = useRef(false);

  const micOnRef = useRef(false);
  const micArmedRef = useRef(false); // user intent (armed)
  const pttHeldRef = useRef(false);

  // ---- Mobile PTT positioning (dockable) ----
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
    dragStartedAtMs: number;
  }>({
    pointerId: null,
    startX: 0,
    startY: 0,
    moved: false,
    dragging: false,
    startedPtt: false,
    holdTimer: null,
    dragStartedAtMs: 0,
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
  const prevPeerCountRef = useRef<number>(0);
  const [joinPulse, setJoinPulse] = useState(false);
  const joinPulseTimerRef = useRef<number | null>(null);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});

  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");

  const [spotlightId, setSpotlightId] = useState<string>("local");

  // ---- Local preview (PiP) behavior -------------------------
  // PiP stays visible by default. On PC it's draggable; on mobile it's fixed bottom-left.
  // Controls for the PiP (pin/flip/cam) are *not* always visible: they only show when PiP is tapped.
  const pipRef = useRef<HTMLDivElement | null>(null);
  const pipDraggingRef = useRef(false);
  const pipDragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const [pipPos, setPipPos] = useState<{ x: number; y: number } | null>(null);
  
  // PiP controls visibility (tap PiP / watermark to show)
    const pipControlsTimerRef = useRef<number | null>(null);

  const [pipAspect, setPipAspect] = useState<number>(16 / 9);
  const [vp, setVp] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Track viewport (for PiP sizing/positioning)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setVp({ w: window.innerWidth || 0, h: window.innerHeight || 0 });
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);


  const pipDims = useMemo(() => {
    const w = vp.w || (typeof window !== "undefined" ? window.innerWidth || 360 : 360);
    const h = vp.h || (typeof window !== "undefined" ? window.innerHeight || 640 : 640);
    const ar = pipAspect && pipAspect > 0 ? pipAspect : 16 / 9; // width / height

    const isLandscapeMobile = isMobile && w > h;

    // Size caps
    // Mobile portrait: keep PiP modest so it doesn't crowd PTT.
    // Mobile landscape: give PiP more height (landscape tends to make PiP look tiny).
    const maxW = isMobile
      ? isLandscapeMobile
        ? Math.min(w * 0.48, 340)
        : Math.min(w * 0.46, 220)
      : 260;

    const maxH = isMobile
      ? isLandscapeMobile
        ? Math.min(h * 0.68, 360)
        : Math.min(h * 0.32, 240)
      : 160;

    const minW = isMobile ? (isLandscapeMobile ? 170 : 130) : 190;

    let outW = maxW;
    let outH = outW / ar;

    if (outH > maxH) {
      outH = maxH;
      outW = outH * ar;
    }
    if (outW < minW) {
      outW = minW;
      outH = outW / ar;
      if (outH > maxH) {
        outH = maxH;
        outW = outH * ar;
      }
    }

    return { w: Math.round(outW), h: Math.round(outH) };
  }, [vp.w, vp.h, pipAspect, isMobile]);

  const clearPipControlsTimer = () => {
    if (pipControlsTimerRef.current) {
      window.clearTimeout(pipControlsTimerRef.current);
      pipControlsTimerRef.current = null;
    }
  };

    // Set an initial position once we have a peer (1:1 view).
  // Mobile: start top-left (selfie-like preview area).
  // Desktop: start bottom-right, above the bottom dock.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Mobile PiP is fixed bottom-left (no stored position).
    if (isMobile) return;
    if (pipPos) return;
    // Only relevant in 1:1 view (remote full + local PiP)
    if (peerIds.length !== 1) return;

    const pad = 12;
    const dock = 120;

    const w = window.innerWidth || 360;
    const h = window.innerHeight || 640;

    const x = Math.max(pad, w - pipDims.w - pad);
    const y = Math.max(pad, h - pipDims.h - dock);
    setPipPos({ x, y });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerIds.length, isMobile, pipDims.w, pipDims.h]);


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

  const pipOnPointerDown = (e: React.PointerEvent) => {
    wakePipControls();
    if (isMobile) return; // mobile PiP is not draggable
    if (!pipPos) return;

    pipDraggingRef.current = true;
    // keep controls visible while dragging
    clearPipControlsTimer();
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

  
  // (PiP initial position handled above)


  useEffect(() => {
    return () => clearPipControlsTimer();
  }, []);

  // Captions / text stream
  const { messages, pushMessage } = useAnySpeakMessages({ max: 30 });
  const [captionLines] = useState<number>(3);

  // Manual text captions
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [ccOn, setCcOn] = useState(false);

  // ✅ Enforced room mode (from DB)
  const roomType: RoomType | null = roomInfo?.room_type ?? null;
  const playJoinChime = useCallback(() => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = 880;
      g.gain.value = 0.0001;
      o.connect(g);
      g.connect(ctx.destination);
      o.start();
      const now = ctx.currentTime;
      g.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.20);
      o.stop(now + 0.22);
      setTimeout(() => {
        try {
          ctx.close();
        } catch {}
      }, 300);
    } catch {}
  }, []);

  useEffect(() => {
    if (roomType !== "audio") return;
    const prev = prevPeerCountRef.current;
    const cur = peerIds.length;
    if (cur > prev) {
      playJoinChime();
      setJoinPulse(true);
      if (joinPulseTimerRef.current) window.clearTimeout(joinPulseTimerRef.current);
      joinPulseTimerRef.current = window.setTimeout(() => setJoinPulse(false), 2000);
    }
    prevPeerCountRef.current = cur;
  }, [peerIds.length, roomType, playJoinChime]);

  // ✅ Joiner camera choice for VIDEO rooms
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);

  // Pre-join
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

  // Track local camera aspect ratio (so PiP can match what the device is actually sending)
  useEffect(() => {
    const s = localStreamRef.current;
    const vt = s?.getVideoTracks?.()?.[0];
    if (!vt) return;

    const apply = () => {
      try {
        const st: any = vt.getSettings ? vt.getSettings() : {};
        const w = Number(st.width || 0);
        const h = Number(st.height || 0);
        if (w > 0 && h > 0) {
          setPipAspect(w / h);
        }
      } catch {}
    };

    apply();
    // Some browsers update settings after a short delay.
    const t = window.setTimeout(apply, 350);
    return () => window.clearTimeout(t);
  }, [camOn, joinCamOn]);


  const { beforeConnect, toggleCamera, flipCamera, canFlip, hdEnabled, setVideoQuality } = useCamera({
    isMobile,
    roomType,
    joinCamOn,
    acquire: async () => {
      return await acquire();
    },
    localStreamRef,
    setCamEnabled,
    peersRef,
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

  const micUiOn = isMobile ? true : (sttListening || sttArmedNotListening);

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
      if ((v as any).dataset?.local === "1") return;
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

  // Mobile control sizing (avoid Tailwind dynamic class issues)
  const PTT_SIZE = 76;
// Button hit areas (visuals are icon-only; these control the tap target size)
const AUX_BTN = isMobile ? 56 : 72;
const TOP_BTN = isMobile ? 56 : 72;

  const online = rtStatus === "SUBSCRIBED";

  const camClass = camOn
    ? "bg-neutral-100 text-neutral-900 border-neutral-300"
    : "bg-red-900/80 text-red-100 border-red-700";

  const micClass = micUiOn
    ? "bg-emerald-600/60 text-white border-emerald-300/30"
    : "bg-red-600/55 text-white border-red-300/30";

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
    const size = 64; // smaller, less ostentatious
    const margin = 12;
    const edgeZone = 44; // must be closer to edge

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

    const {
  topVisible,
  brVisible,
  pipControlsVisible,
  pipPinned,
  wakeTopHud,
  wakeBrHud,
  wakePipControls,
  togglePipPinned,
} = useHudController();



  // ---- Render -----------------------------------------------
return (
  <div
    className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden"
    onMouseMove={(e) => {
      if (isMobile) return;
      const x = e.clientX;
      const y = e.clientY;
      const w = window.innerWidth || 0;
      const h = window.innerHeight || 0;
      if (y < 96) wakeTopHud(true);
      if (y > h - 96 && x > w - 96) wakeBrHud(true);
    }}
  >
    <HudWakeZones
      onWakeTop={() => wakeTopHud()}
      onWakeBottomRight={() => wakeBrHud()}
    />

    <TopHud
  visible={topVisible}
  ccOn={ccOn}
  sdOn={!hdEnabled}
  onToggleCc={() => {
  setCcOn((v) => !v);
  wakeTopHud(true);
}}

  onToggleSd={() => {
    setHdEnabled();
    wakeTopHud(true);
  }}
  onExit={onExit}
/>

<BottomRightHud
  visible={brVisible}
  isMobile={isMobile}
  camOn={camOn}
  micOn={micUiOn}
  showTextInput={showTextInput}
  onToggleCamera={() => {
    toggleCamera();
    wakeBrHud(true);
  }}
  onToggleMic={() => {
    toggleMic();
    wakeBrHud(true);
  }}
  onToggleText={() => {
    setShowTextInput((v) => !v);
    wakeBrHud(true);
  }}
/>

      <div className="relative h-full w-full overflow-hidden">
        {/* ✅ Joiner overlay: only for VIDEO room to choose cam on/off */}
        {roomType === "video" && joinCamOn === null && (
          <div className="absolute inset-0 z-50">
            <div className="absolute inset-0">
              {localStreamRef.current ? (
                <div className="absolute inset-0 opacity-60">
                  <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
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

        {/* Mobile: only the TOP strip brings HUD back (PTT should not pop it) */}
        {isMobile && (
          <div
            className="absolute top-0 left-0 right-0 z-[15] pointer-events-auto"
            style={{ height: "30vh" }}
          />
        )}

        {/* Top floating controls (icons only, no pills/words) */}
        <header
          className={`absolute top-2 left-2 right-2 z-20 pointer-events-none transition-opacity duration-300 ${!topHudVisible ? "opacity-0" : "opacity-100"}`}
        >
          <div className="relative flex items-center justify-center gap-2">
            {/* Audio join pulse (shows when someone joins an audio room) */}
            {joinPulse && (
              <div className="absolute left-0 top-0 pointer-events-none">
                <div className="inline-flex items-center justify-center w-10 h-10 text-white/90">
                  👤
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setCcOn((v) => !v)}
              style={{ width: TOP_BTN, height: TOP_BTN }}
              className={`pointer-events-auto flex items-center justify-center text-lg md:text-xl text-white/90 transition ${
                ccOn ? "opacity-100 font-semibold" : "opacity-70"
              }`}
              title="Closed Captions"
              aria-label="Closed Captions"
            >
              CC
            </button>

            <button
              type="button"
              onClick={() => {
                showPipHudAfterInteraction();
                setVideoQuality(hdEnabled ? "sd" : "hd");
              }}
              style={{ width: TOP_BTN, height: TOP_BTN }}
              className={`pointer-events-auto flex items-center justify-center text-lg md:text-xl text-white/90 transition ${
                hdEnabled ? "opacity-100 font-semibold" : "opacity-70"
              }`}
              title={hdEnabled ? "HD" : "SD"}
              aria-label="Toggle HD"
            >
              {hdEnabled ? "HD" : "SD"}
            </button>

            <button
              type="button"
              onClick={async () => {
                try {
                  const url = window.location.href;
                  // @ts-ignore
                  if (navigator.share) {
                    // @ts-ignore
                    await navigator.share({ url });
                  } else {
                    await navigator.clipboard.writeText(url);
                  }
                } catch {
                  try {
                    const url = window.location.href;
                    await navigator.clipboard.writeText(url);
                  } catch {}
                }
              }}
              style={{ width: TOP_BTN, height: TOP_BTN }}
              className="pointer-events-auto flex items-center justify-center text-2xl text-white/90 opacity-80 hover:opacity-100"
              title="Share"
              aria-label="Share"
            >
              ↗
            </button>

            <button
              type="button"
              onClick={handleEndCall}
              style={{ width: TOP_BTN, height: TOP_BTN }}
              className="pointer-events-auto flex items-center justify-center text-2xl text-red-200 hover:text-red-100"
              title="Exit"
              aria-label="Exit"
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
                Raw audio muted: <span className="font-mono">{shouldMuteRawAudio ? "true" : "false"}</span> ·
                Speak translated:{" "}
                <span className="font-mono">{shouldSpeakTranslated ? "true" : "false"}</span> · Connected:{" "}
                <span className="font-mono">{connected ? "true" : "false"}</span>
              </div>

              <div className="mt-3 max-h-40 overflow-auto rounded-lg bg-black/50 border border-neutral-700 p-2">
                <div className="text-[10px] text-neutral-400 mb-1">Logs</div>
                <pre className="text-[10px] leading-snug whitespace-pre-wrap text-neutral-200">
                  {logs.slice(0, 20).join("\n")}
                </pre>
              </div>
            </div>
          )}

          {/* (Removed) STT status pills */}

          <div className="h-full w-full">
            {/* 0 peers: show local */}
            {peerIds.length === 0 && (
              <div className="relative h-full w-full bg-neutral-900">
                <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
              </div>
            )}

            {/* 1 peer: remote full + local PiP */}
            {peerIds.length === 1 && firstRemoteId && (
              <div className="relative h-full w-full bg-neutral-900">
                <FullBleedVideo stream={firstRemoteStream} fit="cover" />
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

                {roomType === "video" && !pipPinned && !brHudVisible && (
                  <div
                    className="pointer-events-auto z-20 rounded-2xl border border-white/25 bg-transparent"
                    style={
                      isMobile
                        ? {
                            position: "fixed",
                            left: 12,
                            bottom: "calc(env(safe-area-inset-bottom) + 12px)",
                            width: pipDims.w,
                            height: pipDims.h,
                            opacity: 1,
                            transition: "opacity 250ms ease",
                            touchAction: "none",
                            userSelect: "none",
                            WebkitUserSelect: "none",
                          }
                        : {
                            position: "absolute",
                            left: pipPos?.x ?? 16,
                            top: pipPos?.y ?? 16,
                            width: pipDims.w,
                            height: pipDims.h,
                            opacity: 1,
                            transition: "opacity 250ms ease",
                            touchAction: "none",
                            userSelect: "none",
                            WebkitUserSelect: "none",
                          }
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      wakePipControls();
                    }}
                    aria-label="Show PiP"
                    title="Show PiP"
                  />
                )}
                {roomType === "video" && (
                  <div
                    ref={pipRef}
                    className="pointer-events-auto z-30 rounded-2xl overflow-hidden border border-white/10 shadow-xl bg-black"
                    style={
                      isMobile
                        ? {
                            position: "fixed",
                            left: 12,
                            bottom: "calc(env(safe-area-inset-bottom) + 12px)",
                            width: pipDims.w,
                            height: pipDims.h,
                            opacity: pipPinned || brHudVisible ? 1 : 0,
                            transition: "opacity 250ms ease",
                            touchAction: "none",
                            userSelect: "none",
                            WebkitUserSelect: "none",
                          }
                        : {
                            position: "absolute",
                            left: pipPos?.x ?? 16,
                            top: pipPos?.y ?? 16,
                            width: pipDims.w,
                            height: pipDims.h,
                            opacity: pipPinned || brHudVisible ? 1 : 0,
                            transition: "opacity 250ms ease",
                            touchAction: "none",
                            userSelect: "none",
                            WebkitUserSelect: "none",
                          }
                    }
                    onClick={(e) => { e.stopPropagation(); wakePipControls(); }}
                    onPointerDown={pipOnPointerDown}
                    onPointerMove={pipOnPointerMove}
                    title="Your camera"
                    aria-label="Your camera"
                  >
                    {/* Local preview */}
                    {camOn ? (
                      <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
                    ) : (
                      <div className="h-full w-full flex items-center justify-center text-white/80 bg-black/60">
                        <span className="text-lg">📷✕</span>
                      </div>
                    )}

                    {/* PiP controls overlay (camera/pin/flip) */}
                    {pipControlsVisible && (
                      <div className="absolute inset-0 flex items-end justify-end p-2 pointer-events-none">
                        <div className="flex flex-col items-center gap-2 pointer-events-auto">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              togglePipPinned();
                            }}

                            className={`w-9 h-9 rounded-lg bg-black/40 backdrop-blur border border-white/10 text-white/90 shadow flex items-center justify-center ${
                              pipPinned ? "ring-1 ring-white/25" : "opacity-90"
                            }`}
                            title="Pin PiP"
                            aria-label="Pin PiP"
                          >
                            📌
                          </button>

                          {isMobile && canFlip && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                flipCamera();
                                wakePipControls();
                              }}
                              className="w-9 h-9 rounded-lg bg-black/40 backdrop-blur border border-white/10 text-white/90 shadow flex items-center justify-center"
                              title="Switch camera"
                              aria-label="Switch camera"
                            >
                              ↺
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* 2-4 participants: simple grid (prevents accidental duplicate render / weird zoom) */}
            {totalParticipants >= 2 && totalParticipants <= 4 && peerIds.length >= 2 && (
              <div className="grid h-full w-full grid-cols-1 md:grid-cols-2 gap-2 p-2">
                {/* local tile */}
                <div className="relative bg-neutral-900 rounded-2xl overflow-hidden min-h-[240px]">
                  <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
                  <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                    <span>You</span>
                  </div>
                </div>

                {peerIds.map((pid) => (
                  <div
                    key={pid}
                    className="relative bg-neutral-900 rounded-2xl overflow-hidden min-h-[240px]"
                  >
                    <FullBleedVideo stream={peerStreams[pid] ?? null} />
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

            {/* 5+ participants: spotlight mode */}
            {totalParticipants >= 5 && (
              <div className="flex flex-col h-full w-full">
                <div className="relative flex-1 bg-neutral-900 rounded-none md:rounded-2xl overflow-hidden m-0 md:m-2">
                  {spotlightId === "local" ? (
                    <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
                  ) : (
                    <>
                      <FullBleedVideo stream={peerStreams[spotlightId] ?? null} fit="cover" />
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
                  autoFocus
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

        {/* Controls overlay */}
        <div className="fixed inset-0 z-50 pointer-events-none">
          {/* Bottom-center PTT (always visible ring) */}
          <div
  className="fixed left-1/2 -translate-x-1/2 pointer-events-auto"
  style={{ bottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
>

            <button
              type="button"
              aria-label="Push to talk"
              title={micUiOn ? "Hold to talk" : "Mic muted"}
              style={{ width: PTT_SIZE, height: PTT_SIZE, touchAction: "none", userSelect: "none", WebkitUserSelect: "none" }}
              className={`rounded-full border-2 ${micUiOn ? "border-emerald-400/80" : "border-white/25"} bg-black/30 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.06)] active:scale-[0.98] transition flex items-center justify-center`}
             onPointerDown={(e) => {
  if (!micUiOn) return; // Option A: indicator only when muted
  e.preventDefault();
  try { (e.currentTarget as any).setPointerCapture?.(e.pointerId); } catch {}
  pttDown();
}}
onPointerUp={(e) => {
  if (!micUiOn) return;
  e.preventDefault();
  try { (e.currentTarget as any).releasePointerCapture?.(e.pointerId); } catch {}
  pttUp();
}}
onPointerCancel={() => {
  if (!micUiOn) return;
  pttCancel();
}}

              onContextMenu={(e) => e.preventDefault()}
            >
              {/* Mic icon disappears when muted */}
              {micUiOn && <span className="text-2xl">🎙️</span>}
            </button>
          </div>

        {/* Bottom-right wake zone (always tappable) */}
<div
  className="fixed right-0 bottom-0 z-40 pointer-events-auto"
  style={{ width: 120, height: 240 }} // tweak if you want a bigger/smaller wake area
>
  {/* Bottom-right vertical stack: Mic / Camera / Text (fades + disables clicks when hidden) */}
  <div
    className={`absolute right-3 flex flex-col items-center gap-2 transition-opacity duration-300 ${
      brHudVisible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
    }`}
    style={{ bottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
  >
    {!isMobile && (
      <button
        type="button"
        onClick={() => {
          void toggleMic();
          showBrHudAfterInteraction();
        }}
        style={{ width: AUX_BTN, height: AUX_BTN }}
      className={`bg-transparent border-0 shadow-none flex items-center justify-center active:scale-[0.98] transition text-3xl ${
        micUiOn ? "opacity-100" : "opacity-70"
      }`}
        title={micUiOn ? "Mute mic" : "Unmute mic"}
        aria-label="Mic toggle"
      >
        {micUiOn ? "🎙️" : "🎙️✕"}
      </button>
    )}

    {/* keep the rest of your buttons exactly as they are */}
    <button
      type="button"
      onClick={() => {
        toggleCamera();
        showBrHudAfterInteraction();
      }}
      disabled={roomType !== "video"}
      style={{ width: AUX_BTN, height: AUX_BTN }}
  className="bg-transparent border-0 shadow-none flex items-center justify-center active:scale-[0.98] transition text-3xl disabled:opacity-30"
      title="Camera"
      aria-label="Camera toggle"
    >
      {camOn ? "📷" : "📷✕"}
    </button>

    <button
      type="button"
      onClick={() => {
        setShowTextInput((v) => !v);
        showBrHudAfterInteraction();
      }}
      style={{ width: AUX_BTN, height: AUX_BTN }}
  className="bg-transparent border-0 shadow-none flex items-center justify-center active:scale-[0.98] transition text-3xl"
      title={showTextInput ? "Close text" : "Send text"}
      aria-label="Text"
    >
      💬
    </button>
  </div>
</div>


        </div>
      </div>
    </div>
  );
}

























