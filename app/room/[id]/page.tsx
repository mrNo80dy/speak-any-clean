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

// --- Types & Constants ---
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
type RoomInfo = { code: string | null; room_type: RoomType; };

const PTT_SIZE = 84;

// --- Helpers ---

function pickSupportedLang(preferred?: string) {
  const fallback = "en-US";
  const pref = (preferred || "").trim();
  if (!pref) return fallback;
  if (LANGUAGES.some((l) => l.code === pref)) return pref;
  const base = pref.slice(0, 2).toLowerCase();
  const baseMatch = LANGUAGES.find((l) => l.code.toLowerCase().startsWith(base));
  return baseMatch?.code || fallback;
}

async function translateText(fromLang: string, toLang: string, text: string) {
  const trimmed = text.trim();
  if (!trimmed || fromLang === toLang) {
    return { translatedText: trimmed, targetLang: toLang };
  }
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, fromLang, toLang }),
    });
    if (!res.ok) return { translatedText: trimmed, targetLang: toLang };
    const data = await res.json();
    return {
      translatedText: data.translatedText || trimmed,
      targetLang: data.targetLang || toLang,
    };
  } catch (err) {
    console.error("Translation error:", err);
    return { translatedText: trimmed, targetLang: toLang };
  }
}

// --- Main Component ---

export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = params?.id;
  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";
  const debugKey = debugEnabled ? "debug" : "normal";

  // Device detection
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

  // --- HUD & Interaction State ---
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

  // --- Room & Peer State ---
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const peerLabelsRef = useRef<Record<string, string>>({});
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);

  // User Settings
  const [displayName, setDisplayName] = useState<string>("You");
  const displayNameRef = useRef(displayName);
  useEffect(() => { displayNameRef.current = displayName; }, [displayName]);

  const [ccOn, setCcOn] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);

  const roomType: RoomType = roomInfo?.room_type ?? "audio";
  const prejoinDone = roomType === "audio" ? true : joinCamOn !== null;

  const log = (msg: string, rest: any = {}) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    setLogs((l) => [line, ...l].slice(0, 100));
  };

  // --- Language & TTS ---
  const initialLang = useMemo(() => {
    if (typeof navigator === "undefined") return "en-US";
    return pickSupportedLang(navigator.language);
  }, []);

  const [speakLang, setSpeakLang] = useState(initialLang);
  const [targetLang, setTargetLang] = useState(initialLang);
  const speakLangRef = useRef(speakLang);
  const targetLangRef = useRef(targetLang);

  useEffect(() => { speakLangRef.current = speakLang; }, [speakLang]);
  useEffect(() => { targetLangRef.current = targetLang; }, [targetLang]);

  const { speakText, unlockTts } = useAnySpeakTts({
    getLang: () => targetLangRef.current,
    onLog: log,
  });

  const { messages, pushMessage } = useAnySpeakMessages({ max: 30 });

  // --- STT / Audio Logic ---
  const userTouchedMicRef = useRef(false);
  const micOnRef = useRef(false);
  const micArmedRef = useRef(false);
  const pttHeldRef = useRef(false);
  const shouldSpeakTranslatedRef = useRef(true);
  const shouldMuteRawAudioRef = useRef(true);

  const sendFinalTranscript = async (finalText: string, recLang: string) => {
    const text = finalText.trim();
    if (!text) return;

    // Local translation for immediate feedback
    const { translatedText, targetLang: outLang } = await translateText(
      recLang,
      targetLangRef.current,
      text
    );

    pushMessage({
      fromId: clientId,
      fromName: displayNameRef.current,
      originalLang: recLang,
      translatedLang: outLang,
      originalText: text,
      translatedText,
      isLocal: true,
    });

    // Broadcast to others
    channelRef.current?.send({
      type: "broadcast",
      event: "transcript",
      payload: {
        from: clientId,
        text,
        lang: recLang,
        name: displayNameRef.current,
      },
    });
  };

  // --- Media & Camera Hooks ---
  const { mode } = useCallMode({
    modeParam: roomType === "video" ? "video" : "audio",
    participantCount: peerIds.length + 1,
  });

  const localMedia = useLocalMedia({
    wantVideo: mode === "video",
    wantAudio: !isMobile, // On PC, we start audio immediately. On mobile, STT hook manages it.
  });

  const {
    localStreamRef,
    micOn,
    camOn,
    acquire,
    setMicEnabled,
    setCamEnabled,
    attachLocalVideo,
  } = localMedia;

  const {
    toggleCamera,
    flipCamera,
    canFlip,
    hdEnabled,
    setVideoQuality,
  } = useCamera({
    isMobile,
    roomType,
    joinCamOn,
    acquire,
    localStreamRef,
    setCamEnabled,
    peersRef,
    log,
  });

  const {
    sttListening,
    toggleMic,
    pttDown,
    pttUp,
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
    log,
    onFinalTranscript: sendFinalTranscript,
  });

  // UI Mic State
  const micUiOn = isMobile ? true : sttListening;

  // --- WebRTC signaling ---
  const iceServers = useMemo(() => [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
  ], []);

  const {
    makeOffer,
    handleOffer,
    handleAnswer,
    handleIce,
  } = useAnySpeakWebRtc({
    clientId,
    isMobile,
    iceServers,
    localStreamRef,
    peersRef,
    shouldMuteRawAudioRef,
    setConnected,
    log,
    upsertPeerStream: (remoteId, stream) => {
      setPeerStreams((prev) => ({ ...prev, [remoteId]: stream }));
    },
  });

  // --- Realtime / Supabase ---
  const { channelRef } = useAnySpeakRealtime({
    roomId: roomId || "",
    clientId,
    prejoinDone,
    roomType,
    joinCamOn,
    debugKey,
    displayNameRef,
    log,
    onPresenceSync: (channel) => {
      const state = channel.presenceState();
      const others: string[] = [];
      const labels: Record<string, string> = {};

      Object.values(state).forEach((presence: any) => {
        presence.forEach((p: any) => {
          if (p.clientId !== clientId) {
            others.push(p.clientId);
            labels[p.clientId] = p.name || p.clientId.slice(0, 8);
          }
        });
      });

      setPeerIds(others);
      setPeerLabels(labels);
      peerLabelsRef.current = labels;

      // Initiate WebRTC with anyone who doesn't have a peer object yet
      others.forEach((id) => {
        if (!peersRef.current.has(id)) {
          makeOffer(id, channel);
        }
      });
    },
    onWebrtc: async (msg) => {
      const p = msg.payload as WebRTCPayload;
      if (p.from === clientId) return;

      if (p.type === "offer" && p.sdp) {
        await handleOffer(p.from, p.sdp, channelRef.current!);
      } else if (p.type === "answer" && p.sdp) {
        await handleAnswer(p.from, p.sdp);
      } else if (p.type === "ice" && p.candidate) {
        await handleIce(p.from, p.candidate);
      }
    },
    onTranscript: async (msg) => {
      const p = msg.payload as TranscriptPayload;
      if (p.from === clientId) return;

      const { translatedText, targetLang: outLang } = await translateText(
        p.lang,
        targetLangRef.current,
        p.text
      );

      pushMessage({
        fromId: p.from,
        fromName: p.name || "Guest",
        originalLang: p.lang,
        translatedLang: outLang,
        originalText: p.text,
        translatedText,
        isLocal: false,
      });

      if (shouldSpeakTranslatedRef.current) {
        speakText(translatedText, outLang);
      }
    },
  });

  // Fetch Room Info
  useEffect(() => {
    if (!roomId) return;
    const fetchRoom = async () => {
      const { data, error } = await supabase
        .from("rooms")
        .select("code, room_type")
        .eq("id", roomId)
        .maybeSingle();
      if (data) {
        setRoomInfo({ code: data.code, room_type: data.room_type as RoomType });
      }
    };
    fetchRoom();
  }, [roomId]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopAllStt("unmount");
      peersRef.current.forEach((p) => p.pc.close());
      peersRef.current.clear();
    };
  }, []);

  // Keyboard shortcut for PC (Space to talk)
  useEffect(() => {
    if (isMobile) return;
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !showTextInput && document.activeElement?.tagName !== "INPUT") {
        e.preventDefault();
        if (!sttListening) toggleMic();
      }
    };
    window.addEventListener("keydown", down);
    return () => window.removeEventListener("keydown", down);
  }, [isMobile, sttListening, showTextInput, toggleMic]);

  // --- Interaction Handlers ---
  const handleGlobalTouch = useCallback(() => {
    // If the user taps the screen generally, we wake the HUD elements
    wakeTopHud();
    wakeBrHud();
  }, [wakeTopHud, wakeBrHud]);

  const onSendText = (e: FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    sendFinalTranscript(textInput, speakLang);
    setTextInput("");
    setShowTextInput(false);
  };

  // --- Render ---

  // Pre-join screen for Video Rooms
  if (roomType === "video" && joinCamOn === null) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-neutral-950 p-6 text-center">
        <h1 className="text-2xl font-bold mb-8">Join Video Call</h1>
        <div className="flex gap-4">
          <button 
            onClick={() => setJoinCamOn(true)}
            className="px-8 py-4 bg-emerald-600 rounded-2xl font-semibold active:scale-95 transition"
          >
            Camera On
          </button>
          <button 
            onClick={() => setJoinCamOn(false)}
            className="px-8 py-4 bg-neutral-800 rounded-2xl font-semibold active:scale-95 transition"
          >
            Camera Off
          </button>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="h-[100dvh] w-screen bg-neutral-900 text-neutral-100 overflow-hidden relative selection:bg-emerald-500/30 touch-none"
      onPointerDown={handleGlobalTouch}
    >
      {/* 1. Wake Zones - Lowest layer of UI (z-10), invisible but catches taps */}
      <HudWakeZones 
        onWakeTop={() => wakeTopHud(true)} 
        onWakeBottomRight={() => wakeBrHud(true)} 
      />

      {/* 2. Primary UI Components - Middle layer (z-30 to z-50) */}
      <TopHud
        visible={topVisible}
        ccOn={ccOn}
        hdOn={hdEnabled}
        onToggleCc={() => { setCcOn(!ccOn); wakeTopHud(); }}
        onToggleHd={() => { setVideoQuality(hdEnabled ? "sd" : "hd"); wakeTopHud(); }}
        onShare={() => {
          navigator.clipboard.writeText(window.location.href);
          log("Link copied");
        }}
        onExit={() => router.push("/")}
      />

      <BottomRightHud
        visible={brVisible}
        isMobile={isMobile}
        camOn={camOn}
        micOn={micUiOn}
        showTextInput={showTextInput}
        onToggleCamera={() => { toggleCamera(); wakeBrHud(); }}
        onToggleMic={() => { toggleMic(); wakeBrHud(); }}
        onToggleText={() => { setShowTextInput(!showTextInput); wakeBrHud(); }}
      />

      {/* 3. Main Video Layer - Base layer (z-0) */}
      <main className="absolute inset-0 z-0">
        {peerIds.length === 0 ? (
          // Solo view
          <div className="relative h-full w-full">
            <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
            <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/40 pointer-events-none" />
          </div>
        ) : (
          // 1-on-1 view
          <div className="relative h-full w-full">
            <FullBleedVideo stream={peerStreams[peerIds[0]]} fit="cover" />
            
            {/* PiP Layer (Local Camera) */}
            <PipView
              stream={localStreamRef.current}
              isMobile={isMobile}
              visible={true}
              controlsVisible={pipControlsVisible}
              pinned={pipPinned}
              onWakeControls={wakePipControls}
              onTogglePin={togglePipPinned}
              onFlipCamera={canFlip ? flipCamera : undefined}
            />
          </div>
        )}

        {/* CC Overlay */}
        {ccOn && messages.length > 0 && (
          <div className="absolute inset-x-0 bottom-32 px-6 z-20 pointer-events-none flex flex-col gap-3 items-center">
            {messages.slice(-2).map((m) => (
              <div 
                key={m.id} 
                className={`max-w-[90%] md:max-w-xl animate-in fade-in slide-in-from-bottom-2 duration-300`}
              >
                <div className="bg-black/40 backdrop-blur-xl border border-white/10 px-4 py-2.5 rounded-2xl shadow-2xl">
                  <p className="text-[10px] font-bold tracking-widest uppercase opacity-40 mb-0.5">
                    {m.fromName}
                  </p>
                  <p className="text-[15px] leading-snug font-medium">
                    {m.translatedText}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 4. Mobile PTT Overlay (z-40) */}
      {isMobile && (
        <PttButton
          isPressed={sttListening}
          disabled={!micUiOn}
          onPressStart={pttDown}
          onPressEnd={pttUp}
        />
      )}

      {/* 5. Text Input Overlay (z-50) */}
      {showTextInput && (
        <div className="absolute inset-x-0 bottom-24 z-50 flex justify-center px-4 animate-in fade-in zoom-in-95 duration-200">
          <form 
            className="flex gap-2 w-full max-w-lg bg-black/80 backdrop-blur-2xl p-2 rounded-full border border-white/10 shadow-2xl" 
            onSubmit={onSendText}
          >
            <input
              autoFocus
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 bg-transparent border-0 outline-none px-4 text-sm"
            />
            <button 
              type="submit"
              className="bg-emerald-600 h-10 w-10 rounded-full flex items-center justify-center active:scale-90 transition"
            >
              ↑
            </button>
          </form>
        </div>
      )}

      {/* Debug Logs (Optional/Hidden) */}
      {debugEnabled && (
        <div className="absolute top-20 left-4 z-[100] bg-black/80 p-2 text-[10px] font-mono max-h-40 overflow-y-auto w-64 pointer-events-none opacity-50">
          {logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </div>
  );
}
