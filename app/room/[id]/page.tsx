"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "next/navigation";
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

// -------------------- TTS (device voice) --------------------
function speakText(text: string, lang: string, rate = 0.9) {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;

  const clean = (text || "").trim();
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

  // Some browsers load voices async
  const voices = synth.getVoices?.() || [];
  if (voices.length === 0) {
    setTimeout(doSpeak, 150);
    return;
  }

  doSpeak();
}

// Attempt to "unlock" speech on mobile after a user gesture
function unlockTts() {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) return;
  try {
    // A tiny utterance after a click helps on some Android builds
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
    synth.cancel();
  } catch {}
}

/**
 * Front-end helper: call /api/translate
 */
async function translateText(
  fromLang: string,
  toLang: string,
  text: string
): Promise<{ translatedText: string; targetLang: string }> {
  const trimmed = (text || "").trim();
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
  const params = useParams<{ id: string }>();
  const roomId = params?.id;

  // ---- Debug Mode -------------------------------------------------
  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";
  const debugKey = debugEnabled ? "debug" : "normal"; // re-init when query changes

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

  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);

  const peersRef = useRef<Map<string, Peer>>(new Map());
  const peerLabelsRef = useRef<Record<string, string>>({});

  const recognitionRef = useRef<any>(null);

  const sttStatusRef = useRef<SttStatus>("unknown");
  const micOnRef = useRef(false);

  const [rtStatus, setRtStatus] = useState<RealtimeSubscribeStatus | "INIT">("INIT");
  const [rtNonce, setRtNonce] = useState(0);

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);

  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");

  const [micOn, setMicOn] = useState(false); // default muted
  const [camOn, setCamOn] = useState(true);

  const [spotlightId, setSpotlightId] = useState<string>("local");

  // Captions / text stream
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [showCaptions, setShowCaptions] = useState(false);
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

  // ---------- FINAL vs DEBUG behavior ----------
  // Hard requirement: raw remote audio should never play (prevents English bleed).
  const FINAL_MUTE_RAW_AUDIO = true;

  // Debug toggles (only visible in ?debug=1)
  const [debugHearRawAudio, setDebugHearRawAudio] = useState(false);

  // Debug: choose what YOU speak (STT input language)
  const [speakLang, setSpeakLang] = useState<string>(
    (typeof navigator !== "undefined" && navigator.language) || "en-US"
  );
  const speakLangRef = useRef<string>(
    (typeof navigator !== "undefined" && navigator.language) || "en-US"
  );

  // Choose what YOU want captions shown in (and what you want to HEAR for remote speech)
  const [targetLang, setTargetLang] = useState<string>(
    (typeof navigator !== "undefined" && navigator.language) || "en-US"
  );
  const targetLangRef = useRef<string>(
    (typeof navigator !== "undefined" && navigator.language) || "en-US"
  );

  // Effective behavior flags
  const shouldMuteRawAudio = FINAL_MUTE_RAW_AUDIO && !(debugEnabled && debugHearRawAudio);

  // ✅ AUTOSPEAK: always speak translated for REMOTE messages
  const AUTO_SPEAK_TRANSLATED = true;

  const log = (msg: string, ...rest: any[]) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg} ${
      rest.length ? JSON.stringify(rest) : ""
    }`;
    setLogs((l) => [line, ...l].slice(0, 250));
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
    const full: ChatMessage = { ...msg, id: crypto.randomUUID(), at: Date.now() };
    setMessages((prev) => [...prev.slice(-29), full]); // keep last 30
  }

  // ---- keep refs updated -------------------
  useEffect(() => {
    micOnRef.current = micOn;
  }, [micOn]);

  useEffect(() => {
    speakLangRef.current = speakLang;
  }, [speakLang]);

  useEffect(() => {
    targetLangRef.current = targetLang;
  }, [targetLang]);

  useEffect(() => {
    sttStatusRef.current = sttStatus;
  }, [sttStatus]);

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

  // ---- Acquire local media ONCE (prevents Edge flashing on reconnect) ----
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        if (typeof navigator === "undefined") return;
        if (!navigator.mediaDevices?.getUserMedia) return;

        if (localStreamRef.current) return;

        const constraints = {
          audio: true,
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        localStreamRef.current = stream;

        // default mic off
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) audioTrack.enabled = false;
        setMicOn(false);

        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) setCamOn(videoTrack.enabled);

        // attach if video element exists
        if (localVideoRef.current) attachLocalVideoRef(localVideoRef.current);

        log("local media acquired", {
          audioTracks: stream.getAudioTracks().length,
          videoTracks: stream.getVideoTracks().length,
        });
      } catch (err) {
        log("local media error", { err: (err as Error).message });
      }
    })();

    return () => {
      cancelled = true;
      // Stop tracks only on real unmount
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => t.stop());
        localStreamRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      // If you later add TURN, add a SECOND entry here (don’t paste placeholders elsewhere).
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
        // ✅ HARD STOP: never let raw remote audio play unless allowed
        e.track.enabled = !shouldMuteRawAudio;
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

    // Add local tracks if we have them
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

    // Ensure tracks are added if stream exists
    if (localStreamRef.current) {
      const haveKinds = new Set(
        pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
      );

      localStreamRef.current.getTracks().forEach((t) => {
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

  async function handleOffer(fromId: string, sdp: RTCSessionDescriptionInit, channel: RealtimeChannel) {
    const { pc } = getOrCreatePeer(fromId, channel);

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));

    if (localStreamRef.current) {
      const haveKinds = new Set(
        pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
      );

      localStreamRef.current.getTracks().forEach((t) => {
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

  // ---- RAW AUDIO KILL SWITCH (element-level) ------------
  useEffect(() => {
    const allowRaw = !shouldMuteRawAudio;

    document.querySelectorAll<HTMLAudioElement>("audio[data-remote]").forEach((a) => {
      a.muted = !allowRaw;
      a.volume = allowRaw ? 1 : 0;
      if (allowRaw) a.play().catch(() => {});
    });

    document.querySelectorAll<HTMLVideoElement>("video").forEach((v) => {
      if (v === localVideoRef.current) return;
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

    // Clean previous
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
    rec.lang = speakLangRef.current || (navigator.language as string) || "en-US";

    rec.onstart = () => {
      setSttStatus("ok");
      setSttErrorMessage(null);
    };

    rec.onresult = async (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;

      for (let i = event.resultIndex ?? 0; i < results.length; i++) {
        const r = results[i];
        if (!r?.isFinal) continue;

        const raw = r[0]?.transcript || "";
        const text = raw.trim();
        if (!text) continue;

        // Always use latest language choice
        rec.lang = speakLangRef.current || (navigator.language as string) || "en-US";
        const lang = rec.lang || "en-US";
        const fromName = displayName || "You";

        log("stt final", { text, lang });

        const target = targetLangRef.current || "en-US";
        const { translatedText, targetLang: outLang } = await translateText(lang, target, text);

        // Show captions locally
        pushMessage({
          fromId: clientId,
          fromName,
          originalLang: lang,
          translatedLang: outLang,
          originalText: text,
          translatedText,
          isLocal: true,
        });

        // ✅ DO NOT speak your own STT result (prevents self-echo).
        // Only the OTHER device should speak what it receives.

        // Broadcast raw text + lang
        if (channelRef.current) {
          channelRef.current.send({
            type: "broadcast",
            event: "transcript",
            payload: { from: clientId, text, lang, name: fromName },
          });
          log("stt broadcast sent", { text, lang });
        } else {
          log("stt broadcast skipped (no channelRef)", {});
        }
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
      // Android often ends after each phrase; restart if mic still on
      if (micOnRef.current && sttStatusRef.current !== "unsupported") {
        setTimeout(() => {
          try {
            rec.start();
          } catch {}
        }, 200);
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
  }, [displayName, speakLang]);

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

  // ---- Lifecycle: join room, wire realtime -------------------
  useEffect(() => {
    if (!roomId || !clientId) return;
    let isMounted = true;

    (async () => {
      try {
        const channel = supabase.channel(`room:${roomId}`, {
          config: {
            broadcast: { self: false },
            presence: { key: clientId },
          },
        });

        channel.on("broadcast", { event: "webrtc" }, async (message: { payload: WebRTCPayload }) => {
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
        });

        channel.on(
          "broadcast",
          { event: "transcript" },
          async (message: { payload: TranscriptPayload }) => {
            const { payload } = message;
            if (!payload) return;

            const { from, text, lang, name } = payload;
            if (!text || !from || from === clientId) return;

            const fromName = name ?? peerLabelsRef.current[from] ?? from.slice(0, 8) ?? "Guest";

            const target = targetLangRef.current || "en-US";
            const { translatedText, targetLang: outLang } = await translateText(lang, target, text);

            // Show captions
            pushMessage({
              fromId: from,
              fromName,
              originalLang: lang,
              translatedLang: outLang,
              originalText: text,
              translatedText,
              isLocal: false,
            });

            // ✅ AUTOSPEAK: remote messages only
            if (AUTO_SPEAK_TRANSLATED) {
              // Speak only if translation target differs OR you want always for remote
              const shouldSpeak = (outLang || "en-US") !== (lang || "en-US") || true;
              if (shouldSpeak) {
                speakText(translatedText, outLang, 0.9);
              }
            }
          }
        );

        channel.on("broadcast", { event: "hand" }, (message: { payload: { from: string; up: boolean } }) => {
          const { payload } = message;
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
              labels[m.clientId] = (m.name as string | undefined) || m.clientId.slice(0, 8) || "Guest";
            });
          });

          log("presence sync", { othersCount: others.length, others });

          setPeerIds(others);
          setPeerLabels(labels);
          peerLabelsRef.current = labels;

          others.forEach((id) => {
            if (!peersRef.current.has(id)) {
              makeOffer(id, channel).catch((e) => log("offer error", { e: (e as Error).message }));
            }
          });
        });

        channel.subscribe((status: RealtimeSubscribeStatus) => {
          setRtStatus(status);
          log("realtime status", { status });

          if (status === "SUBSCRIBED") {
            log("subscribed to channel", { roomId, clientId });
            channel.track({ clientId, name: displayName });
            return;
          }

          // DO NOT untrack/unsubscribe inside this callback.
          if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
            log("realtime died; scheduling rebuild", { status });
            setTimeout(() => setRtNonce((n) => n + 1), 250);
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

      teardownPeers("effect cleanup");

      // IMPORTANT: do NOT stop local media here (prevents camera flashing on reconnect)
      try {
        if (channelRef.current) {
          channelRef.current.untrack();
          channelRef.current.unsubscribe();
          channelRef.current = null;
        }
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, clientId, displayName, debugKey, rtNonce]);

  // ---- UI controls ------------------------------------------
  const toggleCamera = async () => {
    unlockTts();
    if (!localStreamRef.current) return;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;
    const next = !videoTrack.enabled;
    videoTrack.enabled = next;
    setCamOn(next);
  };

  const toggleMic = async () => {
    unlockTts();
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
    unlockTts();

    const text = textInput.trim();
    if (!text) return;

    const lang = (debugEnabled ? speakLangRef.current : (navigator.language as string)) || "en-US";
    const fromName = displayName || "You";

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

    // Do not speak your own message; the receiver will speak it.

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

  const micClass = micOn
    ? "bg-neutral-800 text-neutral-50 border-neutral-600"
    : "bg-red-900/80 text-red-100 border-red-700";

  const camClass = camOn
    ? "bg-neutral-100 text-neutral-900 border-neutral-300"
    : "bg-red-900/80 text-red-100 border-red-700";

  const effectiveCaptionLines = Math.max(1, captionLines || 3);

  // ---- Render -----------------------------------------------
  return (
    <div className="h-screen w-screen bg-neutral-950 text-neutral-100 overflow-hidden">
      <div className="relative h-full w-full">
        <header className="absolute top-0 left-0 right-0 z-20 flex items-center justify-between gap-2 flex-wrap px-4 py-2 bg-gradient-to-b from-black/70 to-transparent">
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

          <div className="flex-1 text-center order-first md:order-none">
            <h1 className="text-lg md:text-xl font-semibold">Any-Speak</h1>
          </div>

          <div className="flex items-center gap-2">
            <span className={`${pillBase} ${connectedClass}`}>
              {online ? "Online" : "Offline"}
            </span>

            <button onClick={toggleMic} className={`${pillBase} ${micClass}`}>
              {micOn ? "Mic On" : "Mic Off"}
            </button>

            <button onClick={toggleCamera} className={`${pillBase} ${camClass}`}>
              {camOn ? "Cam On" : "Cam Off"}
            </button>

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
                    <option value="en-US">English (en-US)</option>
                    <option value="pt-BR">Português (pt-BR)</option>
                  </select>
                </label>

                <label className="text-xs">
                  <div className="text-neutral-300 mb-1">Show captions in</div>
                  <select
                    value={targetLang}
                    onChange={(e) => setTargetLang(e.target.value)}
                    className="w-full bg-black/60 text-xs border border-neutral-700 rounded-lg px-2 py-2"
                  >
                    <option value="en-US">English (en-US)</option>
                    <option value="pt-BR">Português (pt-BR)</option>
                  </select>
                </label>

                <div className="flex flex-col gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={debugHearRawAudio}
                      onChange={(e) => setDebugHearRawAudio(e.target.checked)}
                    />
                    <span className="text-neutral-200">Hear raw audio (debug only)</span>
                  </label>

                  <div className="text-[10px] text-neutral-400">
                    Tip: after changing “I speak”, toggle Mic Off → On to apply.
                  </div>
                </div>
              </div>

              <div className="mt-2 text-[10px] text-neutral-400">
                Raw audio muted:{" "}
                <span className="font-mono">{shouldMuteRawAudio ? "true" : "false"}</span>{" "}
                · Auto-speak remote translations:{" "}
                <span className="font-mono">{AUTO_SPEAK_TRANSLATED ? "true" : "false"}</span>{" "}
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
          {showCaptions && sttStatus !== "ok" && (
            <div className="absolute top-16 left-4 z-20 text-[10px] md:text-xs text-amber-300 bg-black/60 px-2 py-1 rounded">
              {sttStatus === "unsupported"
                ? "Live captions mic not supported on this device. Use Text button."
                : sttStatus === "error"
                ? sttErrorMessage || "Live captions mic error. Use Text button."
                : "Checking live captions mic..."}
            </div>
          )}

          <div className="h-full w-full">
            {peerIds.length === 0 && (
              <div className="relative h-full w-full bg-neutral-900">
                <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
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
                  <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
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
                  <video ref={attachLocalVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                  <div className="absolute bottom-2 left-2 text-xs bg-neutral-900/70 px-2 py-1 rounded flex items-center gap-1">
                    {myHandUp && <span>✋</span>}
                    <span>You</span>
                  </div>
                </div>

                {peerIds.map((pid) => (
                  <div key={pid} className="relative bg-neutral-900 rounded-2xl overflow-hidden h-full min-h-0">
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
                        className="h-full w-full object-cover"
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
                          className="h-full w-full object-cover"
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
            <form
              onSubmit={handleTextSubmit}
              className="pointer-events-auto absolute inset-x-0 bottom-16 flex justify-center"
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
