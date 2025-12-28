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

type Peer = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
};

type PeerStreams = Record<string, MediaStream>;

type RoomType = "audio" | "video";

type RoomInfo = {
  code: string | null;
  room_type: RoomType;
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

  // STT control refs
  const sttRunningRef = useRef(false);
  const sttStopRequestedRef = useRef(false);
  const sttLastStartAtRef = useRef<number>(0);
  const [sttArmedNotListening, setSttArmedNotListening] = useState(false);
  const sttRestartTimerRef = useRef<number | null>(null);
  const sttLastSentAtRef = useRef<number>(0);

  // Android finalize-on-silence refs
  const sttPendingTextRef = useRef<string>("");
  const sttFinalizeTimerRef = useRef<number | null>(null);

  // keep the last interim phrase so PTT up can still send even if onresult arrives late
  const sttLastInterimRef = useRef<string>("");

  // last sent used for spam prevention
  const sttLastSentRef = useRef<string>("");

  // flush timer so PTT up waits long enough for Android to emit final/onresult
  const sttFlushTimerRef = useRef<number | null>(null);

  const micOnRef = useRef(false);
  const micArmedRef = useRef(false); // user intent (armed)
  const pttHeldRef = useRef(false);

  const [sttListening, setSttListening] = useState(false); // reality (listening)

  const sttStatusRef = useRef<SttStatus>("unknown");
  const displayNameRef = useRef<string>("You");

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");
  const [spotlightId, setSpotlightId] = useState<string>("local");

  // Hand raise state (remote participants)
  const [handsUp, setHandsUp] = useState<Record<string, boolean>>({});
  const [myHandUp, setMyHandUp] = useState(false);


  // Captions / text stream
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [captionLines, setCaptionLines] = useState<number>(3);

  // Manual text captions
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [ccOn, setCcOn] = useState(true);

  // STT status
  const [sttStatus, setSttStatus] = useState<SttStatus>("unknown");
  const [sttErrorMessage, setSttErrorMessage] = useState<string | null>(null);

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


  const clearSttRestartTimer = () => {
    if (sttRestartTimerRef.current) {
      window.clearTimeout(sttRestartTimerRef.current);
      sttRestartTimerRef.current = null;
    }
  };

  const clearFlushTimer = () => {
    if (sttFlushTimerRef.current) {
      window.clearTimeout(sttFlushTimerRef.current);
      sttFlushTimerRef.current = null;
    }
  };

  const clearFinalizeTimer = () => {
    if (sttFinalizeTimerRef.current) {
      window.clearTimeout(sttFinalizeTimerRef.current);
      sttFinalizeTimerRef.current = null;
    }
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

  // ---- ICE candidate queue (pre-SDP safety) -------------------
const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

const enqueueIce = (fromId: string, candidate: RTCIceCandidateInit) => {
  const map = pendingIceRef.current;
  const list = map.get(fromId) ?? [];
  list.push(candidate);
  map.set(fromId, list);
};

const flushIce = async (fromId: string) => {
  const peer = peersRef.current.get(fromId);
  if (!peer) return;

  const pc = peer.pc;
  if (!pc.remoteDescription) return;

  const map = pendingIceRef.current;
  const list = map.get(fromId);
  if (!list || list.length === 0) return;

  map.delete(fromId);

  for (const c of list) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
      log("flushed ice", { from: fromId });
    } catch (err) {
      log("flush ice error", { err: (err as Error).message });
    }
  }
};

  // effective behavior flags
  const shouldMuteRawAudio = FINAL_MUTE_RAW_AUDIO && !debugHearRawAudio;
  const shouldSpeakTranslated =
    FINAL_AUTOSPEAK_TRANSLATED || (debugEnabled && debugSpeakTranslated);

  function pushMessage(msg: Omit<ChatMessage, "id" | "at">) {
    const full: ChatMessage = {
      ...msg,
      id: crypto.randomUUID(),
      at: Date.now(),
    };
    setMessages((prev) => [...prev.slice(-29), full]);
  }

  // ---- keep refs updated ------------------------------------
  useEffect(() => {
    shouldMuteRawAudioRef.current = shouldMuteRawAudio;
  }, [shouldMuteRawAudio]);

  useEffect(() => {
    targetLangRef.current = targetLang;
  }, [targetLang]);

  useEffect(() => {
    sttStatusRef.current = sttStatus;
  }, [sttStatus]);

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

  // ✅ STT send helper (with duplicate protection)
  const sendFinalTranscript = async (finalText: string, recLang: string) => {
    const text = (finalText || "").trim();
    if (!text) return;

    const lastExact = (sttLastSentRef.current || "").trim();
    if (lastExact && lastExact === text) return;

    // Prevent partial spam, but DON'T block real short phrases
    const last = (sttLastSentRef.current || "").trim();
    if (last) {
      if (last.startsWith(text) && last.length - text.length >= 2) return;

      if (text.startsWith(last) && last.length >= 10 && text.length - last.length < 4) return;
    }

    sttLastSentRef.current = text;
    sttLastSentAtRef.current = Date.now();

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

  const startSttNow = () => {
    const rec = recognitionRef.current;
    if (!rec) return;

    clearSttRestartTimer();
    clearFlushTimer();

    rec.lang =
      speakLangRef.current ||
      (typeof navigator !== "undefined" ? (navigator.language as string) : "en-US") ||
      "en-US";

    if (sttRunningRef.current) {
      log("stt start skipped (already running)", { lang: rec.lang });
      return;
    }

    sttStopRequestedRef.current = false;

    try {
      rec.start();
      log("stt start() called (gesture)", { lang: rec.lang });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("already started")) {
        sttRunningRef.current = true;
        log("stt start() already running (ignored)", { lang: rec.lang });
      } else {
        log("stt start() FAILED", { message: msg, lang: rec.lang });
      }
    }
  };

  const stopSttNow = () => {
    const rec = recognitionRef.current;
    if (!rec) return;

    clearSttRestartTimer();

    sttStopRequestedRef.current = true;
    sttRunningRef.current = false;

    try {
      rec.stop();
      log("stt stop() called (gesture)");
    } catch (e: any) {
      log("stt stop() FAILED", { message: e?.message || String(e) });
    }
  };

  const flushPendingStt = (why: string) => {
    clearFinalizeTimer();
    clearFlushTimer();

    // If we already sent something very recently, don't send again from flush.
    const msSinceLastSend = Date.now() - (sttLastSentAtRef.current || 0);
    if (msSinceLastSend < 900) {
      log("flushPendingStt: skipped (recent send)", { why, msSinceLastSend });
      return;
    }

    const pending = (sttPendingTextRef.current || "").trim();
    const interim = (sttLastInterimRef.current || "").trim();

    sttPendingTextRef.current = "";
    const chosen = pending || interim;

    if (!chosen) {
      log("flushPendingStt: no text", { why });
      return;
    }

    sttLastInterimRef.current = "";
    void sendFinalTranscript(chosen, recognitionRef.current?.lang || speakLangRef.current);
    log("flushPendingStt: sent", { why, len: chosen.length });
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

  const micUiOn = isMobile ? sttListening : micOn;

  // ---- Helpers ----------------------------------------------
  function upsertPeerStream(remoteId: string, stream: MediaStream) {
    setPeerStreams((prev) => ({ ...prev, [remoteId]: stream }));
  }

  function teardownPeers(reason: string) {
    log("teardownPeers", { reason });

    pendingIceRef.current.clear();

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

  function getOrCreatePeer(remoteId: string, channel: RealtimeChannel) {
    const existing = peersRef.current.get(remoteId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 4,
    });

    const remoteStream = new MediaStream();

    pc.oniceconnectionstatechange = () => {
      log(`ice(${remoteId}) state: ${pc.iceConnectionState}`);
    };

    pc.onicegatheringstatechange = () => {
      log(`iceGather(${remoteId}) state: ${pc.iceGatheringState}`);
    };

    pc.onconnectionstatechange = () => {
      log(`pc(${remoteId}) state: ${pc.connectionState}`);

      if (pc.connectionState === "connected") setConnected(true);

      if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        peersRef.current.delete(remoteId);
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
      if (e.track?.kind === "audio") {
        e.track.enabled = !shouldMuteRawAudioRef.current;
      }

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

    // Add local tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((t) => {
        // mobile: keep STT-only policy by not sending audio
        if (isMobile && t.kind === "audio") return;
        pc.addTrack(t, localStreamRef.current!);
      });
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

    if (localStreamRef.current) {
      const haveKinds = new Set(
        pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
      );

      localStreamRef.current.getTracks().forEach((t) => {
        if (isMobile && t.kind === "audio") return;
        if (!haveKinds.has(t.kind)) pc.addTrack(t, localStreamRef.current!);
      });
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
    await flushIce(fromId);

    if (localStreamRef.current) {
      const haveKinds = new Set(
        pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
      );

      localStreamRef.current.getTracks().forEach((t) => {
        if (isMobile && t.kind === "audio") return;
        if (!haveKinds.has(t.kind)) pc.addTrack(t, localStreamRef.current!);
      });
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
    await flushIce(fromId);
    log("applied answer", { from: fromId });
  }

  async function handleIce(fromId: string, candidate: RTCIceCandidateInit) {
  // Ensure peer exists (so we have somewhere to queue against)
  const peer = peersRef.current.get(fromId);
  if (!peer) {
    enqueueIce(fromId, candidate);
    log("queued ice (no peer yet)", { from: fromId });
    return;
  }

  if (!peer.pc.remoteDescription) {
    enqueueIce(fromId, candidate);
    log("queued ice (no remoteDescription yet)", { from: fromId });
    return;
  }

  try {
    await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    log("added ice", { from: fromId });
  } catch (err) {
    log("ice error", { err: (err as Error).message });
  }
}


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

    const prev = recognitionRef.current;
    if (prev) {
      try {
        prev.onend = null;
        prev.onresult = null;
        prev.onerror = null;
        prev.onstart = null;
        prev.stop();
      } catch {}
      recognitionRef.current = null;
    }

    const rec = new SpeechRecognitionCtor();
    rec.continuous = true;
    rec.interimResults = true;
    if (speakLangRef.current) rec.lang = speakLangRef.current;

    rec.onstart = () => {
      setSttArmedNotListening(false);
      setSttListening(true);

      sttLastStartAtRef.current = Date.now();
      sttRunningRef.current = true;
      sttStopRequestedRef.current = false;

      sttPendingTextRef.current = "";
      sttLastInterimRef.current = "";

      log("stt onstart", { lang: rec.lang });
      setSttStatus("ok");
      setSttErrorMessage(null);
    };

    rec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;

      if (speakLangRef.current) rec.lang = speakLangRef.current;

      let sawFinal = false;
      let newestText = "";

      for (let i = event.resultIndex ?? 0; i < results.length; i++) {
        const r = results[i];
        const t = (r?.[0]?.transcript || "").trim();
        if (!t) continue;

        newestText = t;
        sttLastInterimRef.current = t;

        if (r.isFinal) {
          sawFinal = true;

          // ✅ PTT FIX: while holding PTT on mobile, DO NOT send on finals.
          // Android often emits many "finals" incrementally (4,7,9,14,25,41...)
          // We only want ONE send: on release (flush).
          if (isMobile && pttHeldRef.current) {
            sttPendingTextRef.current = t;
            continue;
          }

          sttPendingTextRef.current = "";
          clearFinalizeTimer();
          void sendFinalTranscript(t, rec.lang);
        }
      }

      // ✅ While holding PTT on mobile, do NOT run finalize-on-silence timer
      // (it causes spam/partials while still holding)
      if (isMobile && pttHeldRef.current) {
        if (newestText) sttPendingTextRef.current = newestText;
        return;
      }

      // Desktop / non-PTT behavior: finalize on silence
      if (!sawFinal && newestText) {
        sttPendingTextRef.current = newestText;
        clearFinalizeTimer();

        sttFinalizeTimerRef.current = window.setTimeout(() => {
          const pending = sttPendingTextRef.current.trim();
          sttPendingTextRef.current = "";
          if (pending) void sendFinalTranscript(pending, rec.lang);
        }, 1400);
      }
    };

    rec.onerror = (event: any) => {
      log("stt error", { error: event?.error, message: event?.message, event });
      setSttStatus("error");
      setSttErrorMessage(event?.error || event?.message || "Speech recognition error.");

      if (
        event?.error === "audio-capture" ||
        event?.error === "not-allowed" ||
        event?.error === "service-not-allowed"
      ) {
        sttStopRequestedRef.current = true;
        clearSttRestartTimer();
        clearFlushTimer();
        try {
          rec.stop();
        } catch {}
      }
    };

    rec.onend = () => {
      sttRunningRef.current = false;

      const ranForMs = Date.now() - (sttLastStartAtRef.current || Date.now());
      log("stt onend", { stopRequested: sttStopRequestedRef.current, ranForMs });

      if (!sttStopRequestedRef.current && ranForMs < 800) {
        log("stt ended too fast; disabling auto-restart", { ranForMs });
        setSttStatus("error");
        setSttErrorMessage(
          "Android Chrome ended captions mic instantly. Check mic permission, close other apps using mic, and reload the page."
        );
        sttStopRequestedRef.current = true;
        clearSttRestartTimer();
        clearFlushTimer();
        return;
      }

      // If we requested stop (PTT up), Android often emits late results.
      // So: schedule one last flush shortly after onend.
      if (sttStopRequestedRef.current) {
        clearFlushTimer();
        sttFlushTimerRef.current = window.setTimeout(() => {
          flushPendingStt("onend-after-stop");
          setSttListening(false);
        }, 300);
      }

      // Android: don't auto-restart
      if (isMobile) {
        setSttListening(false);

        if (micArmedRef.current && !sttStopRequestedRef.current) {
          setSttArmedNotListening(true);
          log("stt ended (mobile) — needs manual resume", { ranForMs });
        }
        return;
      }

      // Desktop: keep auto-restart
      if (micOnRef.current && !sttStopRequestedRef.current) {
        clearSttRestartTimer();
        sttRestartTimerRef.current = window.setTimeout(() => {
          try {
            if (!sttRunningRef.current) {
              rec.start();
              log("stt auto-restart start() called", { lang: rec.lang });
            }
          } catch (e: any) {
            log("stt auto-restart FAILED", { message: e?.message || String(e) });
          }
        }, 400);
      }
    };

    recognitionRef.current = rec;

    return () => {
      clearFinalizeTimer();
      clearSttRestartTimer();
      clearFlushTimer();
      sttPendingTextRef.current = "";
      sttLastInterimRef.current = "";
      try {
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugKey, speakLang]);  // ---- Lifecycle: join room, wire realtime -------------------
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
    beforeConnect: async () => {
      // ✅ Acquire media only if needed.
      // - Mobile never grabs mic (Web Speech uses mic)
      // - Video rooms grab camera; audio rooms do not
      const needVideo = roomType === "video";
      const canAcquire =
        !(isMobile && roomType === "audio") && (needVideo || !isMobile);

      if (canAcquire) {
        await acquire();

        log("local media acquired", {
          audioTracks: localStreamRef.current?.getAudioTracks().length ?? 0,
          videoTracks: localStreamRef.current?.getVideoTracks().length ?? 0,
          roomType,
        });

        // ✅ Mobile: free the mic for Web Speech STT (even in video mode, we don't want raw audio track)
        if (isMobile && localStreamRef.current) {
          const ats = localStreamRef.current.getAudioTracks();
          ats.forEach((t) => {
            try {
              t.stop();
            } catch {}
            try {
              localStreamRef.current?.removeTrack(t);
            } catch {}
          });
          if (ats.length)
            log("mobile: removed local audio tracks to unblock STT", { removed: ats.length });
        }
      } else {
        log("skipping getUserMedia (mobile STT-only audio room)", { roomType });
      }

      // ✅ Enforce camera state based on room type + joiner choice
      if (roomType === "video") {
        const wantCam = joinCamOn === null ? true : joinCamOn;
        setCamEnabled(wantCam);
        const vt = localStreamRef.current?.getVideoTracks?.()[0];
        if (vt) vt.enabled = wantCam;
        log("forced cam state (video room)", { wantCam });
      } else {
        setCamEnabled(false);
        const vt = localStreamRef.current?.getVideoTracks?.()[0];
        if (vt) vt.enabled = false;
        log("forced cam OFF (audio room)", {});
      }
    },
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
    onTranscript: async (message, channel) => {
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
    onHand: (message, channel) => {
      const payload = message?.payload as { from: string; up: boolean } | undefined;
      if (!payload) return;

      const { from, up } = payload;
      if (!from || from === clientId) return;
      setHandsUp((prev) => ({ ...prev, [from]: up }));
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
        stopSttNow();

        if (isMobile) {
          micArmedRef.current = false;
          setSttListening(false);
          setSttArmedNotListening(false);
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
  const toggleCamera = async () => {
    if (roomType !== "video") return;
    const s = localStreamRef.current;
    const vt = s?.getVideoTracks?.()[0] || null;
    if (!vt) return;
    setCamEnabled(!vt.enabled);
  };

  const toggleMic = async () => {
    userTouchedMicRef.current = true;
    unlockTts();

    if (isMobile) {
      if (sttListening) {
        micArmedRef.current = false;
        setSttArmedNotListening(false);
        stopSttNow();
        setSttListening(false);

        clearFlushTimer();
        sttFlushTimerRef.current = window.setTimeout(() => {
          flushPendingStt("toggleMic-off");
        }, 650);

        log("mobile mic OFF (stt)", {});
        return;
      } else {
        micArmedRef.current = true;
        setSttArmedNotListening(false);
        startSttNow();
        log("mobile mic ON (stt)", {});
        return;
      }
    }

    const next = !micOn;
    micOnRef.current = next;

    if (!next) setSttArmedNotListening(false);

    setMicEnabled(next);

    if (next && sttStatusRef.current !== "unsupported") startSttNow();
    else stopSttNow();
  };

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

                <div className="absolute bottom-4 right-4 w-32 h-20 md:w-48 md:h-28 rounded-xl overflow-hidden border border-neutral-700 bg-black/70 shadow-lg">
                  <video
                    data-local="1"
                    ref={attachLocalVideo}
                    autoPlay
                    playsInline
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

                pttHeldRef.current = true;
                userTouchedMicRef.current = true;
                unlockTts();
                micArmedRef.current = true;
                setSttArmedNotListening(false);

                sttPendingTextRef.current = "";
                sttLastInterimRef.current = "";

                startSttNow();
                setSttListening(true);
                log("PTT down", {});
              }}
              onPointerUp={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                pttHeldRef.current = false;
                try {
                  e.currentTarget.releasePointerCapture(e.pointerId);
                } catch {}

                micArmedRef.current = false;
                stopSttNow();

                clearFlushTimer();
                sttFlushTimerRef.current = window.setTimeout(() => {
                  flushPendingStt("PTT up");
                  setSttListening(false);
                  log("PTT up", {});
                }, 650);
              }}
              onPointerCancel={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                if (!pttHeldRef.current) return;
                pttHeldRef.current = false;

                micArmedRef.current = false;
                stopSttNow();

                clearFlushTimer();
                sttFlushTimerRef.current = window.setTimeout(() => {
                  flushPendingStt("PTT cancel");
                  setSttListening(false);
                  log("PTT cancel", {});
                }, 650);
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




