"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useCamera } from "@/hooks/useCamera";
import { useAnySpeakMessages } from "@/hooks/useAnySpeakMessages";
import { useHudController } from "@/hooks/useHudController";
import FullBleedVideo from "@/components/FullBleedVideo";
import { TopHud } from "@/components/TopHud";
import { BottomRightHud } from "@/components/BottomRightHud";

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const roomId = params?.id;

  // --- State ---
  const [hasJoined, setHasJoined] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [isTalking, setIsTalking] = useState(false);
  const [ccOn, setCcOn] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);

  const { messages } = useAnySpeakMessages({ max: 20 });
  const { topVisible, brVisible, wakeTopHud, wakeBrHud } = useHudController();

  const {
    localStreamRef,
    camOn,
    micOn,
    acquire,
    setCamEnabled,
    setMicEnabled,
    stop,
  } = useLocalMedia({ wantVideo: true });

  const { toggleCamera, hdEnabled, setVideoQuality } = useCamera({
    isMobile,
    roomType: "video",
    acquire,
    localStreamRef,
    setCamEnabled
  });

  // Device Detection
  useEffect(() => {
    const ua = navigator.userAgent;
    setIsMobile(/Android|iPhone|iPad|iPod/i.test(ua));
  }, []);

  // --- Handlers ---
  const handleJoin = async (video: boolean) => {
    try {
      await acquire();
      setCamEnabled(video);
      // PC: Mic starts ON. Phone: Mic starts OFF (for PTT).
      setMicEnabled(!isMobile); 
      setHasJoined(true);
      setStreamVersion(v => v + 1);
    } catch (e) {
      console.error("Join failed", e);
    }
  };

  const handlePttStart = useCallback(() => {
    if (!isMobile) return;
    setIsTalking(true);
    setMicEnabled(true); 
  }, [isMobile, setMicEnabled]);

  const handlePttEnd = useCallback(() => {
    if (!isMobile) return;
    setIsTalking(false);
    setMicEnabled(false); 
  }, [isMobile, setMicEnabled]);

  const handleShare = useCallback(() => {
    if (typeof navigator !== "undefined" && navigator.share) {
      navigator.share({
        title: "Join my AnySpeak Room",
        url: window.location.href,
      }).catch(() => {});
    }
  }, []);

  const handleExit = useCallback(() => {
    stop();
    router.push("/");
  }, [router, stop]);

  // Clean up media on unmount
  useEffect(() => { return () => stop(); }, [stop]);

  // --- LOBBY VIEW ---
  if (!hasJoined) {
    return (
      <div className="h-[100dvh] w-screen bg-black flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-4xl font-black mb-2 text-emerald-500 italic tracking-tighter">AnySpeak</h1>
        <p className="text-white/50 mb-12">Ready to enter the room?</p>
        <div className="flex flex-col gap-4 w-full max-w-xs">
          <button onClick={() => handleJoin(true)} className="bg-emerald-600 hover:bg-emerald-500 py-4 rounded-2xl font-bold transition-all shadow-lg shadow-emerald-900/20">Join with Camera</button>
          <button onClick={() => handleJoin(false)} className="bg-white/5 hover:bg-white/10 border border-white/10 py-4 rounded-2xl font-bold transition-all">Join Audio Only</button>
        </div>
      </div>
    );
  }

  // --- ROOM VIEW ---
  return (
    <div className="h-[100dvh] w-screen bg-black text-white overflow-hidden relative" onPointerDown={() => { wakeTopHud(); wakeBrHud(); }}>
      <main className="absolute inset-0 z-0">
        <FullBleedVideo key={`v-${streamVersion}`} stream={localStreamRef.current} isLocal fit="cover" />

        {/* Captions Rendering - Using translatedText primarily */}
        {ccOn && messages.length > 0 && (
          <div className="absolute inset-x-0 bottom-44 px-6 z-20 pointer-events-none flex flex-col items-center gap-3">
            {messages.slice(-2).map((m) => (
              <div key={m.id} className="bg-black/60 backdrop-blur-xl px-5 py-3 rounded-2xl border border-white/10 max-w-[90%] shadow-2xl">
                <p className="text-[18px] font-semibold text-center leading-tight">
                  {m.translatedText || "..."}
                </p>
              </div>
            ))}
          </div>
        )}

        {/* PHONE PTT RING (Mobile Only) */}
        {isMobile && (
          <div className="absolute inset-x-0 bottom-12 flex justify-center z-30">
            <button
              onPointerDown={handlePttStart}
              onPointerUp={handlePttEnd}
              onPointerLeave={handlePttEnd}
              className={`w-28 h-28 rounded-full border-4 transition-all flex items-center justify-center ${
                isTalking ? "bg-emerald-500 border-emerald-300 scale-110 shadow-[0_0_50px_rgba(16,185,129,0.7)]" : "bg-transparent border-white/20"
              }`}
            >
              <span className="text-3xl">{isTalking ? "🎙️" : "⭕"}</span>
            </button>
          </div>
        )}
      </main>

      <TopHud 
        visible={topVisible} 
        ccOn={ccOn} 
        hdOn={hdEnabled} 
        onToggleCc={() => setCcOn(!ccOn)} 
        onToggleHd={() => setVideoQuality(hdEnabled ? "sd" : "hd")} 
        onShare={handleShare}
        onExit={handleExit} 
      />

      <BottomRightHud 
        visible={brVisible} 
        isMobile={isMobile} 
        camOn={camOn} 
        micOn={micOn} 
        showTextInput={showTextInput} 
        onToggleCamera={toggleCamera} 
        onToggleMic={() => setMicEnabled(!micOn)} 
        onToggleText={() => setShowTextInput(!showTextInput)} 
      />
    </div>
  );
}
