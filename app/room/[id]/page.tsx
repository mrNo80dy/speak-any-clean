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

// --- Types ---
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

// This interface fixes your "implicitly has any type" error
interface SupabaseRoomResponse {
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
  if (!trimmed || fromLang === toLang) return { translatedText: trimmed, targetLang: toLang };
  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, fromLang, toLang }),
    });
    if (!res.ok) return { translatedText: trimmed, targetLang: toLang };
    const data = await res.json();
    return { translatedText: data.translatedText || trimmed, targetLang: data.targetLang || toLang };
  } catch (err) {
    return { translatedText: trimmed, targetLang: toLang };
  }
}
export default function RoomPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const roomId = params?.id;
  const searchParams = useSearchParams();
  const debugEnabled = searchParams?.get("debug") === "1";
  const debugKey = debugEnabled ? "debug" : "normal";

  const isMobile = useMemo(() => typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent), []);
  const clientId = useMemo(() => {
    if (typeof window === "undefined") return "server";
    let id = sessionStorage.getItem("clientId");
    if (!id) { id = crypto.randomUUID(); sessionStorage.setItem("clientId", id); }
    return id;
  }, []);

  const peersRef = useRef<Map<string, Peer>>(new Map());
  const displayNameRef = useRef("You");
  const speakLangRef = useRef("en-US");
  const targetLangRef = useRef("en-US");
  const shouldMuteRawAudioRef = useRef(true);

  const [peerIds, setPeerIds] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);
  const [joinCamOn, setJoinCamOn] = useState<boolean | null>(null);
  const [ccOn, setCcOn] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);
  const [textInput, setTextInput] = useState("");
  const [logs, setLogs] = useState<string[]>([]);

  const { topVisible, brVisible, pipControlsVisible, pipPinned, wakeTopHud, wakeBrHud, wakePipControls, togglePipPinned } = useHudController();
  const roomType: RoomType = roomInfo?.room_type ?? "audio";
  const prejoinDone = roomType === "audio" ? true : joinCamOn !== null;

  const log = useCallback((msg: string) => {
    setLogs((l) => [`[${new Date().toISOString().slice(11, 19)}] ${msg}`, ...l].slice(0, 50));
  }, []);

  const [speakLang, setSpeakLang] = useState(() => pickSupportedLang(typeof navigator !== "undefined" ? navigator.language : "en-US"));
  const [targetLang, setTargetLang] = useState(speakLang);

  useEffect(() => {
    speakLangRef.current = speakLang;
    targetLangRef.current = targetLang;
  }, [speakLang, targetLang]);

  const { messages, pushMessage } = useAnySpeakMessages({ max: 30 });
  const { speakText, unlockTts } = useAnySpeakTts({ getLang: () => targetLangRef.current, onLog: log });

  const sendFinalTranscript = async (text: string, lang: string) => {
    const { translatedText, targetLang: outLang } = await translateText(lang, targetLangRef.current, text);
    pushMessage({ fromId: clientId, fromName: displayNameRef.current, originalLang: lang, translatedLang: outLang, originalText: text, translatedText, isLocal: true });
    channelRef.current?.send({ type: "broadcast", event: "transcript", payload: { from: clientId, text, lang, name: displayNameRef.current } });
  };

  const localMedia = useLocalMedia({ wantVideo: roomType === "video", wantAudio: !isMobile });
  const { localStreamRef, micOn, camOn, acquire, setMicEnabled, setCamEnabled } = localMedia;

  const { toggleCamera, flipCamera, canFlip, hdEnabled, setVideoQuality } = useCamera({ isMobile, roomType, joinCamOn, acquire, localStreamRef, setCamEnabled, peersRef, log });

  const { sttListening, toggleMic, pttDown, pttUp, stopAllStt } = useAnySpeakStt({ 
    isMobile, debugKey, speakLang, userTouchedMicRef: useRef(false), micOnRef: useRef(false), micArmedRef: useRef(false), pttHeldRef: useRef(false), 
    micOn, setMicEnabled, unlockTts, log, onFinalTranscript: sendFinalTranscript 
  });

  const { makeOffer, handleOffer, handleAnswer, handleIce } = useAnySpeakWebRtc({
    clientId, isMobile, iceServers: [{ urls: "stun:stun.l.google.com:19302" }], localStreamRef, peersRef, shouldMuteRawAudioRef, setConnected: () => {}, log,
    upsertPeerStream: (id, stream) => setPeerStreams(prev => ({ ...prev, [id]: stream }))
  });

  const { channelRef } = useAnySpeakRealtime({
    roomId: roomId || "", clientId, prejoinDone, roomType, joinCamOn, debugKey, displayNameRef, log,
    teardownPeers: (id) => {
      const p = peersRef.current.get(id);
      if (p) { p.pc.close(); peersRef.current.delete(id); setPeerIds(prev => prev.filter(pId => pId !== id)); setPeerStreams(prev => { const n = {...prev}; delete n[id]; return n; }); }
    },
    onPresenceSync: (channel) => {
      const state = channel.presenceState();
      const others = Object.values(state).flatMap((p: any) => p).filter(p => p.clientId !== clientId).map(p => p.clientId);
      setPeerIds(others);
      others.forEach(id => { if (!peersRef.current.has(id)) makeOffer(id, channel); });
    },
    onWebrtc: async (msg) => {
      const p = msg.payload as WebRTCPayload;
      if (p.from === clientId) return;
      if (p.type === "offer" && p.sdp) await handleOffer(p.from, p.sdp, channelRef.current!);
      else if (p.type === "answer" && p.sdp) await handleAnswer(p.from, p.sdp);
      else if (p.type === "ice" && p.candidate) await handleIce(p.from, p.candidate);
    },
    onTranscript: async (msg) => {
      const p = msg.payload as TranscriptPayload;
      if (p.from === clientId) return;
      const { translatedText, targetLang: outLang } = await translateText(p.lang, targetLangRef.current, p.text);
      pushMessage({ fromId: p.from, fromName: p.name || "Guest", originalLang: p.lang, translatedLang: outLang, originalText: p.text, translatedText, isLocal: false });
      speakText(translatedText, outLang);
    }
  });
  // Fixed Camera Trigger & Typed Supabase Fetch
  useEffect(() => {
    if (prejoinDone) {
      log("Acquiring media...");
      acquire().then(() => {
        if (roomType === "video" && joinCamOn === false) setCamEnabled(false);
      });
    }
  }, [prejoinDone, acquire, roomType, joinCamOn, setCamEnabled]);

  useEffect(() => {
    if (!roomId) return;
    // We cast the response to SupabaseRoomResponse to satisfy the build
    supabase.from("rooms").select("code, room_type").eq("id", roomId).maybeSingle()
      .then(({ data }: { data: SupabaseRoomResponse | null }) => {
        if (data) setRoomInfo({ code: data.code, room_type: data.room_type as RoomType });
      });
  }, [roomId]);

  if (roomType === "video" && joinCamOn === null) {
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-black text-white gap-6">
        <h1 className="text-2xl font-bold">Join Video Room</h1>
        <div className="flex gap-4">
          <button onClick={() => setJoinCamOn(true)} className="px-8 py-4 bg-emerald-600 rounded-2xl font-bold active:scale-95 transition">Camera On</button>
          <button onClick={() => setJoinCamOn(false)} className="px-8 py-4 bg-neutral-800 rounded-2xl font-bold active:scale-95 transition">Camera Off</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-screen bg-neutral-950 text-neutral-100 overflow-hidden relative touch-none select-none" onPointerDown={() => { wakeTopHud(); wakeBrHud(); }}>
      
      {/* 1. WAKE ZONES - Set to z-0 so they don't block icons */}
      <div className="absolute inset-0 z-0">
        <HudWakeZones onWakeTop={() => wakeTopHud(true)} onWakeBottomRight={() => wakeBrHud(true)} />
      </div>

      {/* 2. VIDEO LAYER - z-10 */}
      <main className="absolute inset-0 z-10">
        {peerIds.length === 0 ? (
          <FullBleedVideo stream={localStreamRef.current} isLocal fit="cover" />
        ) : (
          <div className="relative h-full w-full">
            <FullBleedVideo stream={peerStreams[peerIds[0]]} fit="cover" />
            <PipView stream={localStreamRef.current} isMobile={isMobile} visible={true} controlsVisible={pipControlsVisible} pinned={pipPinned} onWakeControls={wakePipControls} onTogglePin={togglePipPinned} onFlipCamera={canFlip ? flipCamera : undefined} />
          </div>
        )}
      </main>

      {/* 3. CAPTIONS - z-20 */}
      {ccOn && messages.length > 0 && (
        <div className="absolute inset-x-0 bottom-36 px-6 z-20 pointer-events-none flex flex-col gap-3 items-center">
          {messages.slice(-2).map((m) => (
            <div key={m.id} className="bg-black/50 backdrop-blur-2xl border border-white/10 px-5 py-3 rounded-2xl">
              <p className="text-[10px] font-bold opacity-40 uppercase tracking-widest">{m.fromName}</p>
              <p className="text-[16px] font-medium leading-tight">{m.translatedText}</p>
            </div>
          ))}
        </div>
      )}

      {/* 4. INTERACTIVE UI - z-50 to ensure icons are tappable */}
      <div className="relative z-50 pointer-events-none h-full w-full">
        <TopHud visible={topVisible} ccOn={ccOn} hdOn={hdEnabled} onToggleCc={() => setCcOn(!ccOn)} onToggleHd={() => setVideoQuality(hdEnabled ? "sd" : "hd")} onShare={() => navigator.clipboard.writeText(window.location.href)} onExit={() => router.push("/")} />
        <BottomRightHud visible={brVisible} isMobile={isMobile} camOn={camOn} micOn={isMobile ? true : sttListening} showTextInput={showTextInput} onToggleCamera={toggleCamera} onToggleMic={toggleMic} onToggleText={() => setShowTextInput(!showTextInput)} />
        {isMobile && <PttButton isPressed={sttListening} disabled={false} onPressStart={pttDown} onPressEnd={pttUp} />}
      </div>

      {/* 5. TEXT INPUT - z-[60] */}
      {showTextInput && (
        <div className="absolute inset-x-0 bottom-24 z-[60] flex justify-center px-4">
          <form className="flex gap-2 w-full max-w-lg bg-black/90 p-2 rounded-full border border-white/10 pointer-events-auto shadow-2xl" onSubmit={(e) => { e.preventDefault(); if(textInput.trim()) { sendFinalTranscript(textInput, speakLang); setTextInput(""); setShowTextInput(false); } }}>
            <input autoFocus value={textInput} onChange={(e) => setTextInput(e.target.value)} placeholder="Type a message..." className="flex-1 bg-transparent border-0 outline-none px-4 text-white" />
            <button type="submit" className="bg-emerald-600 h-10 w-10 rounded-full flex items-center justify-center text-white">↑</button>
          </form>
        </div>
      )}
    </div>
  );
}
