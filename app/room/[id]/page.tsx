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

// --- Types & Interfaces ---

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

/**
 * Data shape from the Supabase 'rooms' table
 */
interface RoomRow {
  code: string | null;
  room_type: string;
}

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

  // Identity & Environment
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

  // --- Refs (Stability) ---
  const peersRef = useRef<Map<string, Peer>>(new Map());
  const peerLabelsRef = useRef<Record<string, string>>({});
  const userTouchedMicRef = useRef(false);
  const micOnRef = useRef(false);
  const micArmedRef = useRef(false);
  const pttHeldRef = useRef(false);
  const shouldSpeakTranslatedRef = useRef(true);
  const shouldMuteRawAudioRef = useRef(true);
  const displayNameRef = useRef<string>("You");
  const speakLangRef = useRef<string>("en-US");
  const targetLangRef = useRef<string>("en-US");

  // --- State ---
  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [peerLabels, setPeerLabels] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [displayName, setDisplayName] = useState<string>("You");
  const [ccOn, setCcOn] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);

  // HUD Visibility Controller
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

  const roomType: RoomType = roomInfo?.room_type ?? "audio";
  const prejoinDone = roomType === "audio" ? true : joinCamOn !== null;

  const log = useCallback((msg: string, rest: any = {}) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
    setLogs((l) => [line, ...l].slice(0, 50));
  }, []);

  // --- Language Setup ---
  const initialLang = useMemo(() => {
    if (typeof navigator === "undefined") return "en-US";
    return pickSupportedLang(navigator.language);
  }, []);

  const [speakLang, setSpeakLang] = useState(initialLang);
  const [targetLang, setTargetLang] = useState(initialLang);

  useEffect(() => {
    speakLangRef.current = speakLang;
    targetLangRef.current = targetLang;
    displayNameRef.current = displayName;
  }, [speakLang, targetLang, displayName]);

  // --- Core Hooks ---
  const { messages, pushMessage } = useAnySpeakMessages({ max: 30 });
  const { speakText, unlockTts } = useAnySpeakTts({
    getLang: () => targetLangRef.current,
    onLog: log,
  });

  const sendFinalTranscript = async (finalText: string, recLang: string) => {
    const text = finalText.trim();
    if (!text) return;

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

    channelRef.current?.send({
      type: "broadcast",
      event: "transcript",
      payload: {
        from: clientId,
        text,
        lang: recLang,
        name: displayNameRef.current,
      } as TranscriptPayload,
    });
  };

  const { mode } = useCallMode({
    modeParam: roomType === "video" ? "video" : "audio",
    participantCount: peerIds.length + 1,
  });

  const localMedia = useLocalMedia({
    wantVideo: mode === "video",
    wantAudio: !isMobile,
  });

  const {
    localStreamRef,
    micOn,
    camOn,
    acquire,
    setMicEnabled,
    setCamEnabled,
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

  const {
    makeOffer,
    handleOffer,
    handleAnswer,
    handleIce,
  } = useAnySpeakWebRtc({
    clientId,
    isMobile,
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    localStreamRef,
    peersRef,
    shouldMuteRawAudioRef,
    setConnected,
    log,
    upsertPeerStream: (remoteId, stream) => {
      setPeerStreams((prev) => ({ ...prev, [remoteId]: stream }));
    },
  });

  const { channelRef } = useAnySpeakRealtime({
    roomId: roomId || "",
    clientId,
    prejoinDone,
    roomType,
    joinCamOn,
    debugKey,
    displayNameRef,
    log,
    teardownPeers: (id: string) => {
      const peer = peersRef.current.get(id);
      if (peer) {
        peer.pc.close();
        peersRef.current.delete(id);
        setPeerIds((prev) => prev.filter((pId) => pId !== id));
        setPeerStreams((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
        log(`Cleanup peer: ${id}`);
      }
    },
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

  // --- Data Fetching & Lifecyle ---

  useEffect(() => {
    if (!roomId) return;
    
    // Fixed: Explicit type for Supabase data to resolve build error
    supabase
      .from("rooms")
      .select("code, room_type")
      .eq("id", roomId)
      .maybeSingle()
      .then(({ data, error }: { data: RoomRow | null; error: any }) => {
        if (data) {
          setRoomInfo({ code: data.code, room_type: data.room_type as RoomType });
        }
        if (error) console.error("Room fetch error:", error);
      });
  }, [roomId]);

  useEffect(() => {
    return () => {
      stopAllStt("unmount");
      peersRef.current.forEach((p) => p.pc.close());
      peersRef.current.clear();
    };
  }, [stopAllStt]);

  const micUiOn = isMobile ? true : sttListening;

  // --- Rendering ---

  if (roomType === "video" && joinCamOn === null) {
    return (
      <div className="flex flex-col items-center justify-center h-[100dvh] bg-black text-white p-6">
        <h1 className="text-2xl font-bold mb-8">Join the conversation</h1>
        <div className="flex gap-4">
          <button
            onClick={() => setJoinCamOn(true)}
            className="px-8 py-4 bg-emerald-600 rounded-2xl font-bold text-lg active:scale-95 transition shadow-lg"
          >
            Camera On
          </button>
          <button
            onClick={() => setJoinCamOn(false)}
            className="px-8 py-4 bg-neutral-800 rounded-2xl font-bold text-lg active:scale-95 transition shadow-lg"
          >
            Camera Off
          </button>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden relative touch-none select-none"
      onPointerDown={() => {
        wakeTopHud();
        wakeBrHud();
      }}
    >
      {/* 1. Wake Zones (z-10) - Ensures tapping near edges wakes HUD */}
      <HudWakeZones 
        onWakeTop={() => wakeTopHud(true)} 
        onWakeBottomRight={() => wakeBrHud(true)} 
      />

      {/* 2. Primary UI Overlays (z-30) */}
      <TopHud
        visible={topVisible}
        ccOn={ccOn}
        hdOn={hdEnabled}
        onToggleCc={() => { setCcOn(!ccOn); wakeTopHud(); }}
        onToggleHd={() => { setVideoQuality(hdEnabled ? "sd" : "hd"); wakeTopHud(); }}
        onShare={() => {
          navigator.clipboard.writeText(window.location.href);
          log("Room link copied");
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

      {/* 3. Main Stream Area (z-0) */}
      <main className="absolute inset-0 z-0">
        {peerIds.length === 0 ? (
          <div className="relative h-full w-full">
            <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
            <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/20 pointer-events-none" />
          </div>
        ) : (
          <div className="relative h-full w-full">
            <FullBleedVideo stream={peerStreams[peerIds[0]]} fit="cover" />
            
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

        {/* CC Display (z-20) */}
        {ccOn && messages.length > 0 && (
          <div className="absolute inset-x-0 bottom-36 px-6 z-20 pointer-events-none flex flex-col gap-3 items-center">
            {messages.slice(-2).map((m) => (
              <div 
                key={m.id} 
                className="max-w-[90%] md:max-w-xl animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                <div className="bg-black/50 backdrop-blur-2xl border border-white/10 px-5 py-3 rounded-2xl shadow-2xl">
                  <p className="text-[10px] font-bold tracking-[0.15em] uppercase opacity-40 mb-1">
                    {m.fromName}
                  </p>
                  <p className="text-[16px] leading-tight font-medium">
                    {m.translatedText}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 4. Interaction Buttons (z-40 & z-50) */}
      {isMobile && (
        <PttButton
          isPressed={sttListening}
          disabled={!micUiOn}
          onPressStart={pttDown}
          onPressEnd={pttUp}
        />
      )}

      {showTextInput && (
        <div className="absolute inset-x-0 bottom-24 z-50 flex justify-center px-4 animate-in fade-in zoom-in-95 duration-200">
          <form 
            className="flex gap-2 w-full max-w-lg bg-black/90 backdrop-blur-3xl p-2 rounded-full border border-white/10 shadow-2xl" 
            onSubmit={(e) => {
              e.preventDefault();
              if (textInput.trim()) {
                sendFinalTranscript(textInput, speakLang);
                setTextInput("");
                setShowTextInput(false);
              }
            }}
          >
            <input
              autoFocus
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              placeholder="Type a message..."
              className="flex-1 bg-transparent border-0 outline-none px-5 text-sm text-white"
            />
            <button 
              type="submit"
              className="bg-emerald-600 h-11 w-11 rounded-full flex items-center justify-center active:scale-90 transition text-white text-lg"
            >
              ↑
            </button>
          </form>
        </div>
      )}

      {/* 5. Debug Console */}
      {debugEnabled && (
        <div className="absolute top-24 left-4 z-[100] bg-black/80 p-3 text-[10px] font-mono max-h-48 overflow-y-auto w-72 pointer-events-none opacity-40 rounded-xl border border-white/5">
          {logs.map((l, i) => (
            <div key={i} className="mb-0.5">{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}
