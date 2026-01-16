"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useLocalMedia } from "@/hooks/useLocalMedia";
import { useCamera } from "@/hooks/useCamera";
import { useAnySpeakMessages } from "@/hooks/useAnySpeakMessages";
import { useHudController } from "@/hooks/useHudController";
import FullBleedVideo from "@/components/FullBleedVideo";
import { TopHud } from "@/components/TopHud";
import { BottomRightHud } from "@/components/BottomRightHud";

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const roomId = params?.id;

  // 1. App State
  const [hasJoined, setHasJoined] = useState(false);
  const [ccOn, setCcOn] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [isTalking, setIsTalking] = useState(false);

  const { messages } = useAnySpeakMessages({ max: 20 });
  const { topVisible, brVisible, wakeTopHud, wakeBrHud } = useHudController();

  // 2. Media Hooks
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
    isMobile: true, // This should ideally be detected via UserAgent
    roomType: "video",
    acquire,
    localStreamRef,
    setCamEnabled
  });

  // 3. Actions
  const handleJoin = async (video: boolean) => {
    try {
      await acquire();
      setCamEnabled(video);
      setMicEnabled(true);
      setHasJoined(true);
      setStreamVersion(v => v + 1);
    } catch (e) {
      console.error("Join failed", e);
    }
  };

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

  // Cleanup
  useEffect(() => { return () => stop(); }, [stop]);

  // --- LOBBY UI ---
  if (!hasJoined) {
    return (
      <div className="h-[100dvh] w-screen bg-black flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-2xl font-bold mb-8">Ready to join?</h1>
        <div className="flex flex-col gap-4 w-full max-w-xs">
          <button 
            onClick={() => handleJoin(true)}
            className="bg-emerald-600 hover:bg-emerald-500 py-4 rounded-2xl font-bold transition-all"
          >
            Join with Camera
          </button>
          <button 
            onClick={() => handleJoin(false)}
            className="bg-white/10 hover:bg-white/20 py-4 rounded-2xl font-bold transition-all"
          >
            Join Audio Only
          </button>
        </div>
      </div>
    );
  }

  // --- ROOM UI ---
  return (
    <div 
      className="h-[100dvh] w-screen bg-black text-white overflow-hidden relative select-none"
      onPointerDown={() => { wakeTopHud(); wakeBrHud(); }}
    >
      <main className="absolute inset-0 z-0">
        <FullBleedVideo 
          key={`v-${streamVersion}`}
          stream={localStreamRef.current} 
          isLocal 
          fit="cover" 
        />

        {/* CC Overlay */}
        {ccOn && messages.length > 0 && (
          <div className="absolute inset-x-0 bottom-40 px-6 z-20 pointer-events-none flex flex-col items-center gap-3">
            {messages.slice(-2).map((m) => (
              <div key={m.id} className="bg-black/70 backdrop-blur-xl px-5 py-3 rounded-2xl border border-white/10 max-w-[85%]">
                <p className="text-[17px] font-medium text-center">{m.translatedText || ""}</p>
              </div>
            ))}
          </div>
        )}

        {/* THE PTT HOLLOW RING (For Mobile/Phone) */}
        <div className="absolute inset-x-0 bottom-12 flex justify-center z-30 pointer-events-none">
          <button
            onPointerDown={() => setIsTalking(true)}
            onPointerUp={() => setIsTalking(false)}
            onPointerLeave={() => setIsTalking(false)}
            className={`w-24 h-24 rounded-full border-4 transition-all pointer-events-auto flex items-center justify-center ${
              isTalking ? "bg-emerald-500 border-emerald-400 scale-110 shadow-[0_0_30px_rgba(16,185,129,0.5)]" : "bg-transparent border-white/20"
            }`}
          >
             <span className="text-3xl">{isTalking ? "🎙️" : "⭕"}</span>
          </button>
        </div>
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
        isMobile={false} 
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
