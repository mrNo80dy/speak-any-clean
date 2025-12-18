"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";
import { LANGUAGES } from "@/lib/languages";
import { useCallMode } from "@/hooks/useCallMode";
import { useLocalMedia } from "@/hooks/useLocalMedia";

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

// Pick a safe default that actually exists in LANGUAGES
function pickSupportedLang(preferred?: string) {
  const fallback = "en-US";
  const pref = (preferred || "").trim();

  if (!pref) return fallback;

  // exact match
  if (LANGUAGES.some((l) => l.code === pref)) return pref;

  // try same base language (e.g. en-US -> en, or en -> en-US)
  const base = pref.slice(0, 2).toLowerCase();
  const baseMatch =
    LANGUAGES.find((l) => l.code.toLowerCase() === base) ||
    LANGUAGES.find((l) => l.code.toLowerCase().startsWith(base));

  return baseMatch?.code || fallback;
}

// 🔊 Speak text using the device voice
function speakText(text: string, lang: string, rate = 0.9) {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;

  const clean = text.trim();
  if (!clean) return;

  const doSpeak = () => {
    try {
      synth.cancel();
    } catch {}

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = lang || "en-US";
    utterance.rate = rate;

    const voices = synth.getVoices?.() || [];
    const match =
      voices.find((v) => v.lang === utterance.lang) ||
      voices.find((v) => v.lang.startsWith(utterance.lang.slice(0, 2)));

    if (match) utterance.voice = match;

    utterance.onerror = (e) => console.warn("[TTS] error", e);
    synth.speak(utterance);
  };

  const voices = synth.getVoices?.() || [];
  if (voices.length === 0) {
    setTimeout(doSpeak, 150);
    return;
  }

  doSpeak();
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

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  // ---- Debug Mode + URL params ---------------------------------
  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";
  const debugKey = debugEnabled ? "debug" : "normal";

  const modeParam = (searchParams?.get("mode") || "").toLowerCase(); // "audio" | "video" | ""

  // Pre-join: require explicit choice (no auto start)
  const [prejoinDone, setPrejoinDone] = useState<boolean>(
    modeParam === "audio" || modeParam === "video"
  );

  const [chosenMode, setChosenMode] = useState<"audio" | "video" | null>(
    modeParam === "video" ? "video" : modeParam === "audio" ? "audio" : null
  );

  // Use this everywhere instead of raw modeParam during the “start call” click tick
  const effectiveModeParam = chosenMode ?? (modeParam as any) ?? "audio";

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
  const channelRef = useRef<RealtimeChannel | null>(null);
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const peerLabelsRef = useRef<Record<string, string>>({});
  const recognitionRef = useRef<any>(null);

  const shouldSpeakTranslatedRef = useRef(false);
  const shouldMuteRawAudioRef = useRef(true);

  // Track if user manually touched mic so we don't "helpfully" auto-mute later
  const userTouchedMicRef = useRef(false);

  // STT control refs (IMPORTANT: only declared ONCE)
  const sttRunningRef = useRef(false);
  const sttStopRequestedRef = useRef(false);
  const sttLastStartAtRef = useRef<number>(0);
  const [sttArmedNotListening, setSttArmedNotListening] = useState(false);
  const sttRestartTimerRef = useRef<number | null>(null);

  // Android finalize-on-silence refs
  const sttPendingTextRef = useRef<string>("");
  const sttFinalizeTimerRef = useRef<number | null>(null);
  const sttLastSentRef = useRef<string>("");

  const micOnRef = useRef(false);
  const micArmedRef = useRef(false); // user intent (armed)

  const [sttListening, setSttListening] = useState(false); // reality (listening)

  const sttStatusRef = useRef<SttStatus>("unknown");
  const displayNameRef = useRef<string>("You");

  const rebuildTimerRef = useRef<number | null>(null);
  const rebuildScheduledRef = useRef(false);

  const lastRtStatusRef = useRef<string>("INIT");

  const [rtStatus, setRtStatus] = useState<RealtimeSubscribeStatus | "INIT">("INIT");
  const [rtNonce, setRtNonce] = useState(0);

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");

  const [spotlightId, setSpotlightId] = useState<string>("local");

  // Captions / text stream
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const showCaptions = true; // ✅ always on
  const [captionLines, setCaptionLines] = useState<number>(3);

  // Manual text captions
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");

  // Hand raise state (remote participants)
  const [handsUp, setHandsUp] = useState<Record<string, boolean>>({});
  const [myHandUp, setMyHandUp] = useState(false);

  // STT status
  const [sttStatus, setSttStatus] = useState<SttStatus>("unknown");
  const [sttErrorMessage, setSttErrorMessage] = useState<string | null>(null);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // ✅ STT “finalize on silence” helpers (Android fix)
  const clearFinalizeTimer = () => {
    if (sttFinalizeTimerRef.current) {
      window.clearTimeout(sttFinalizeTimerRef.current);
      sttFinalizeTimerRef.current = null;
    }
  };

 const sendFinalTranscript = async (finalText: string, recLang: string) => {
  const text = finalText.trim();
  if (!text) return;

  // ✅ Prevent "incremental partial spam" like:
  // "are you there can" -> "are you there can you" -> "are you there can you hear me"
  const last = (sttLastSentRef.current || "").trim();
  if (last) {
    // if new text is basically the old text plus a tiny bit, don't send yet
    if (text.startsWith(last) && text.length - last.length < 8) return;

    // if Android sends a shorter rollback, ignore it
    if (last.startsWith(text)) return;
  }

  sttLastSentRef.current = text;

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
  }

  log("stt sent transcript", { lang, textLen: text.length });
};

  const startSttNow = () => {
    const rec = recognitionRef.current;
    if (!rec) return;

    clearSttRestartTimer();

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

  const flushPendingStt = () => {
  clearFinalizeTimer();
  const pending = (sttPendingTextRef.current || "").trim();
  sttPendingTextRef.current = "";
  if (pending) void sendFinalTranscript(pending, recognitionRef.current?.lang || speakLangRef.current);
};


  // ---- Hooks you built ---------------------------------------
  const participantCount = peerIds.length + 1;
  const { mode, micDefaultOn, camDefaultOn } = useCallMode({
    modeParam: effectiveModeParam,
    participantCount,
  });

  const localMedia = useLocalMedia({
    wantVideo: mode === "video",
    wantAudio: true, // ✅ always request mic permission (STT still needs it)
  });


  const { localStreamRef, micOn, camOn, acquire, attachLocalVideo, setMicEnabled, setCamEnabled } =
    localMedia;
  const micUiOn = isMobile ? sttListening : micOn;

  // ---- Helpers ----------------------------------------------
  function upsertPeerStream(remoteId: string, stream: MediaStream) {
    setPeerStreams((prev) => ({ ...prev, [remoteId]: stream }));
  }

  function teardownPeers(reason: string) {
    log("teardownPeers", { reason });

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

  function getOrCreatePeer(remoteId: string, channel: RealtimeChannel) {
    const existing = peersRef.current.get(remoteId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }],
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

  // ---- RAW AUDIO KILL SWITCH (element-level, reliable on mobile) ------------
  useEffect(() => {
    const allowRaw = !shouldMuteRawAudio;

    document.querySelectorAll<HTMLAudioElement>("audio[data-remote]").forEach((a) => {
      a.muted = !allowRaw;
      a.volume = allowRaw ? 1 : 0;
      if (allowRaw) a.play().catch(() => {});
    });

    document.querySelectorAll<HTMLVideoElement>("video").forEach((v) => {
      if (v.dataset?.local === "1") return; // avoid local video element
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
      setSttArmedNotListening(false); // ✅ clear banner when listening resumes
      setSttListening(true);

      sttLastStartAtRef.current = Date.now();
      sttRunningRef.current = true;
      sttStopRequestedRef.current = false;
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

        if (r.isFinal) {
          sawFinal = true;
          sttPendingTextRef.current = "";
          clearFinalizeTimer();
          void sendFinalTranscript(t, rec.lang);
        }
      }

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
        try {
          rec.stop();
        } catch {}
      }
    };

    rec.onend = () => {
      sttRunningRef.current = false;

      const ranForMs = Date.now() - (sttLastStartAtRef.current || Date.now());
      log("stt onend", { stopRequested: sttStopRequestedRef.current, ranForMs });

      // If it ended instantly, keep your existing error behavior
      if (!sttStopRequestedRef.current && ranForMs < 800) {
        log("stt ended too fast; disabling auto-restart", { ranForMs });
        setSttStatus("error");
        setSttErrorMessage(
          "Android Chrome ended captions mic instantly. Check mic permission, close other apps using mic, and reload the page."
        );
        sttStopRequestedRef.current = true;
        clearSttRestartTimer();
        return;
      }

      // ✅ Android: don't auto-restart (prevents "ding ding" loop)
      // ✅ Keep mic UI "armed" until user turns it off
      if (isMobile) {
        setSttListening(false);

        // If it ended on its own while armed, show the "resume" hint
        if (micArmedRef.current && !sttStopRequestedRef.current) {
          setSttArmedNotListening(true);
          log("stt ended (mobile) — needs manual resume", { ranForMs });
        }
        return;
      }

      // Desktop: keep your auto-restart behavior
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
      sttPendingTextRef.current = "";
      try {
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugKey, speakLang]);

  // ---- Lifecycle: join room, wire realtime -------------------
  useEffect(() => {
    if (!roomId || !clientId) return;
    if (!prejoinDone) return; // ✅ do not start media/realtime until choice made

    let alive = true;

    const scheduleRebuildOnce = (why: any) => {
      if (rebuildScheduledRef.current) return;
      rebuildScheduledRef.current = true;
      log("realtime died; scheduling rebuild", why);

      rebuildTimerRef.current = window.setTimeout(() => {
        rebuildScheduledRef.current = false;
        setRtNonce((n) => n + 1);
      }, 500);
    };

    (async () => {
      try {
  // ✅ Always acquire once so the browser grants mic permission (STT needs it)
  await acquire();

  log("local media acquired", {
    audioTracks: localStreamRef.current?.getAudioTracks().length ?? 0,
    videoTracks: localStreamRef.current?.getVideoTracks().length ?? 0,
    mode,
  });

  // ...the rest of your code continues here (setCamEnabled, setMicEnabled, etc)
} catch (err) {
  log("init error", { err: (err as Error).message });
}



        // Apply hook-driven defaults
        // - camera: on for video mode, off for audio mode
        setCamEnabled(camDefaultOn);

        // - mic default: on for 1:1 (<=2 total), off for 3+ total
        //   but don't auto-start STT on mobile until user taps mic
        if (!isMobile) {
          setMicEnabled(micDefaultOn);
          micOnRef.current = micDefaultOn;
        } else {
          setMicEnabled(false);
          micOnRef.current = false;
        }

        const channel = supabase.channel(`room:${roomId}`, {
          config: {
            broadcast: { self: false },
            presence: { key: clientId },
          },
        });

        channelRef.current = channel;

        channel.on("broadcast", { event: "webrtc" }, async (message: any) => {
          const payload = message?.payload as WebRTCPayload | undefined;
          if (!payload) return;

          const { type, from, to } = payload;
          log("rx webrtc", { type, from, to });
          if (!type) return;
          if (!from) return;
          if (from === clientId) return;
          if (to && to !== clientId) return;

          if (type === "offer" && payload.sdp) {
            await handleOffer(from, payload.sdp, channel);
          } else if (type === "answer" && payload.sdp) {
            await handleAnswer(from, payload.sdp);
          } else if (type === "ice" && payload.candidate) {
            await handleIce(from, payload.candidate);
          }
        });

        channel.on("broadcast", { event: "transcript" }, async (message: any) => {
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
            speakText(translatedText, outLang, 0.9);
          }
        });

        channel.on("broadcast", { event: "hand" }, (message: any) => {
          const payload = message?.payload as { from: string; up: boolean } | undefined;
          if (!payload) return;
          const { from, up } = payload;
          if (!from || from === clientId) return;
          setHandsUp((prev) => ({ ...prev, [from]: up }));
        });

        channel.on("presence", { event: "sync" }, () => {
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

          // ✅ 3+ users default: mic OFF (unless user already touched mic)
          const total = others.length + 1;
          if (total >= 3 && !userTouchedMicRef.current) {
            // Desktop: turn off the actual audio track
            if (!isMobile) {
              setMicEnabled(false);
            }

            // Shared refs/state
            micOnRef.current = false;
            stopSttNow();
            sttPendingTextRef.current = "";
            clearFinalizeTimer();


            // ✅ Mobile-only: clear the "armed/resume" UI state too
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
        });

        channel.subscribe((status: RealtimeSubscribeStatus) => {
          if (!alive) return;

          if (lastRtStatusRef.current !== status) {
            lastRtStatusRef.current = status;
            log("realtime status", { status });
          }

          setRtStatus(status);

          if (status === "SUBSCRIBED") {
            channel.track({ clientId, name: displayNameRef.current });
            return;
          }

          if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
            scheduleRebuildOnce({ status });
          }
        });
      } catch (err) {
        log("init error", { err: (err as Error).message });
      }
    })();

    return () => {
      alive = false;

      if (rebuildTimerRef.current) {
        clearTimeout(rebuildTimerRef.current);
        rebuildTimerRef.current = null;
      }
      rebuildScheduledRef.current = false;

      teardownPeers("effect cleanup");

      try {
        const ch = channelRef.current;
        if (ch) {
          ch.untrack();
          ch.unsubscribe();
        }
      } catch {}
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, clientId, debugKey, rtNonce, prejoinDone, mode]);

  // ---- UI controls ------------------------------------------
  const toggleCamera = async () => {
    if (mode === "audio") return;
    const s = localStreamRef.current;
    const vt = s?.getVideoTracks?.()[0] || null;
    if (!vt) return;
    setCamEnabled(!vt.enabled);
  };

  const toggleMic = async () => {
    userTouchedMicRef.current = true;

    if (isMobile) {
      // Mobile: button reflects LISTENING state
      if (sttListening) {
        // user turns OFF
        micArmedRef.current = false;
        setSttArmedNotListening(false);
        stopSttNow();
        setSttListening(false); // reflect immediately
        log("mobile mic OFF (stt)", {});
        return;
      } else {
        // user turns ON / RESUME
        micArmedRef.current = true;
        setSttArmedNotListening(false);
        startSttNow();
        log("mobile mic ON (stt)", {});
        return;
      }
    }

    // Desktop: use audio track state
    const next = !micOn;
    micOnRef.current = next;

    if (!next) setSttArmedNotListening(false);

    setMicEnabled(next);

    if (next && sttStatusRef.current !== "unsupported") startSttNow();
    else stopSttNow();
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

  const handleTextSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const text = textInput.trim();
    if (!text) return;

    const lang =
      (debugEnabled ? speakLangRef.current : (navigator.language as string)) || "en-US";

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

  const micClass = micUiOn
    ? "bg-neutral-800 text-neutral-50 border-neutral-600"
    : "bg-red-900/80 text-red-100 border-red-700";

  const camClass = camOn
    ? "bg-neutral-100 text-neutral-900 border-neutral-300"
    : "bg-red-900/80 text-red-100 border-red-700";

  const effectiveCaptionLines = Math.max(1, captionLines || 3);

  const shareRoomCode = async () => {
    const code = roomInfo?.code;
    if (!code) return;

    const shareText = `Any-Speak room code: ${code}`;

    try {
      // @ts-ignore
      if (navigator.share) {
        // @ts-ignore
        await navigator.share({ text: shareText });
      } else {
        await navigator.clipboard.writeText(code);
        log("copied room code", { code });
      }
    } catch {
      try {
        await navigator.clipboard.writeText(code);
        log("copied room code", { code });
      } catch {}
    }
  };

    // ---- Render -----------------------------------------------
  return (
    <div className="h-screen w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="relative h-full w-full">
        {/* Pre-join overlay */}
        {!prejoinDone && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
            <div className="w-full max-w-sm rounded-2xl border border-neutral-700 bg-neutral-950 p-4">
              <div className="text-lg font-semibold mb-2">Start call</div>
              <div className="text-sm text-neutral-300 mb-4">
                Choose audio or video. (You can switch later.)
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button
                  className="rounded-xl border border-neutral-700 bg-neutral-900 px-3 py-3 text-sm"
                  onClick={() => {
                    setChosenMode("audio");
                    const qs = new URLSearchParams(searchParams?.toString() || "");
                    qs.set("mode", "audio");
                    if (debugEnabled) qs.set("debug", "1");
                    router.replace(`/room/${roomId}?${qs.toString()}`);
                    setPrejoinDone(true);
                  }}
                >
                  Audio
                </button>

                <button
                  className="rounded-xl border border-neutral-700 bg-emerald-600 px-3 py-3 text-sm text-white"
                  onClick={() => {
                    setChosenMode("video");
                    const qs = new URLSearchParams(searchParams?.toString() || "");
                    qs.set("mode", "video");
                    if (debugEnabled) qs.set("debug", "1");
                    router.replace(`/room/${roomId}?${qs.toString()}`);
                    setPrejoinDone(true);
                  }}
                >
                  Video
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Minimal top header (mobile safe) */}
        <header className="absolute top-0 left-0 right-0 z-20 px-3 py-2 bg-gradient-to-b from-black/70 to-transparent">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {roomInfo?.code && (
                <>
                  <span className="text-[10px] text-neutral-300">Room</span>
                  <span className="px-2 py-1 rounded-full bg-neutral-900/80 border border-neutral-700 font-mono tracking-[0.25em] text-[10px]">
                    {roomInfo.code}
                  </span>
                  <button
                    type="button"
                    onClick={shareRoomCode}
                    className="px-2 py-1 rounded-full bg-neutral-900/80 border border-neutral-700 text-[10px]"
                  >
                    Share
                  </button>
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <span className={`${pillBase} ${connectedClass}`}>
                {online ? "Online" : "Offline"}
              </span>
            </div>
          </div>
        </header>

        <main className="absolute inset-0 pt-10 md:pt-14">
          {/* Debug Panel */}
          {debugEnabled && (
            <div className="absolute top-14 left-1/2 -translate-x-1/2 z-30 w-[95%] max-w-2xl p-3 rounded-xl bg-neutral-900/90 border border-neutral-700 shadow-lg">
              <div className="text-xs text-neutral-300 mb-2">
                Debug Mode (URL has <span className="font-mono">?debug=1</span>)
                {isMobile ? " · Mobile" : " · Desktop"}
              </div>

              <button
                type="button"
                onClick={() => speakText("Teste de voz", "pt-BR", 0.95)}
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
            <div className="absolute top-16 left-4 z-20 text-[10px] md:text-xs text-amber-300 bg-black/60 px-2 py-1 rounded">
              {sttStatus === "unsupported"
                ? "Live captions mic not supported on this device. Use Text."
                : sttStatus === "error"
                ? sttErrorMessage || "Live captions mic error. Use Text."
                : "Checking live captions mic..."}
            </div>
          )}

          {isMobile && sttArmedNotListening && (
            <div className="absolute top-16 left-4 z-20 text-[10px] md:text-xs text-sky-200 bg-black/60 px-2 py-1 rounded">
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
                  {myHandUp && <span>✋</span>}
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
                  {handsUp[firstRemoteId] && <span>✋</span>}
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
                    {myHandUp && <span>✋</span>}
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
                    {myHandUp && <span>✋</span>}
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
                      {handsUp[pid] && <span>✋</span>}
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
                        {myHandUp && <span>✋</span>}
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
                        {handsUp[spotlightId] && <span>✋</span>}
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
          {messages.length > 0 && (
            <div
              className={`pointer-events-none absolute inset-x-0 ${
                showTextInput ? "bottom-28" : "bottom-20"
              } flex justify-center`}
            >
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

        {/* Bottom control bar */}
        <div className="fixed bottom-0 inset-x-0 z-40 bg-black/70 backdrop-blur border-t border-neutral-800 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <button
              className={`${pillBase} ${micClass} flex-1`touch-none'}
              onPointerDown={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                userTouchedMicRef.current = true;
                micArmedRef.current = true;
                setSttArmedNotListening(false);
                startSttNow();
                setSttListening(true);
                log("PTT down", {});
              }}
              onPointerUp={(e) => {
                if (!isMobile) return;
                e.preventDefault();
                micArmedRef.current = false;
                stopSttNow();
                flushPendingStt();
                setSttListening(false);
                log("PTT up", {});
              }}
              onPointerCancel={() => {
                if (!isMobile) return;
                micArmedRef.current = false;
                stopSttNow();
                flushPendingStt();
                setSttListening(false);
                log("PTT cancel", {});
              }}
              onClick={() => {
                if (isMobile) return;
                toggleMic();
              }}
              onContextMenu={(e) => e.preventDefault()}
            >
              {isMobile
                ? sttListening
                  ? "Hold… Talking"
                  : "Hold to Talk"
                : micOn
                ? "Mic On"
                : "Mic Off"}
            </button>

            <button
              onClick={toggleCamera}
              className={`${pillBase} ${camClass} ${
                mode === "audio" ? "opacity-40 cursor-not-allowed" : ""
              }`}
              disabled={mode === "audio"}
            >
              {camOn ? "Cam" : "Cam Off"}
            </button>

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

            <select
              value={captionLines}
              onChange={(e) => setCaptionLines(Number(e.target.value) || 3)}
              className="bg-neutral-900 text-xs border border-neutral-700 rounded-full px-2 py-1"
              title="Caption lines"
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
              <option value={5}>5</option>
            </select>
          </div>
        </div>

        {/* Hand raise button */}
        <button
          type="button"
          onClick={toggleHand}
          className="fixed bottom-24 right-4 z-30 rounded-full w-12 h-12 flex items-center justify-center bg-amber-500 hover:bg-amber-400 text-black shadow-lg"
        >
          <span className="text-xl">✋</span>
        </button>
      </div>
    </div>
  );
}


