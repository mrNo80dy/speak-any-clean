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

  // State
  const [hasJoined, setHasJoined] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);
  const [isTalking, setIsTalking] = useState(false);
  const [ccOn, setCcOn] = useState(true);

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

  // Detect Device
  useEffect(() => {
    const ua = navigator.userAgent;
    setIsMobile(/Android|iPhone|iPad|iPod/i.test(ua));
  }, []);

  // Actions
  const handleJoin = async (video: boolean) => {
    try {
      await acquire();
      setCamEnabled(video);
      // PC starts with mic on; Phone starts with mic off (ready for PTT)
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
    setMicEnabled(true); // Actually opens the mic track
  }, [isMobile, setMicEnabled]);

  const handlePttEnd = useCallback(() => {
    if (!isMobile) return;
    setIsTalking(false);
    setMicEnabled(false); // Closes the mic track
  }, [isMobile, setMicEnabled]);

  const handleExit = useCallback(() => {
    stop();
    router.push("/");
  }, [router, stop]);

  if (!hasJoined) {
    return (
      <div className="h-[100dvh] w-screen bg-black flex flex-col items-center justify-center p-6 text-center">
        <h1 className="text-3xl font-bold mb-8 text-emerald-500">AnySpeak</h1>
        <div className="flex flex-col gap-4 w-full max-w-xs">
          <button onClick={() => handleJoin(true)} className="bg-emerald-600 py-4 rounded-2xl font-bold">Join with Camera</button>
          <button onClick={() => handleJoin(false)} className="bg-white/10 py-4 rounded-2xl font-bold">Join Audio Only</button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-screen bg-black text-white overflow-hidden relative" onPointerDown={() => { wakeTopHud(); wakeBrHud(); }}>
      <main className="absolute inset-0 z-0">
        <FullBleedVideo key={`v-${streamVersion}`} stream={localStreamRef.current} isLocal fit="cover" />

        {/* CC Overlay */}
        {ccOn && messages.length > 0 && (
          <div className="absolute inset-x-0 bottom-40 px-6 z-20 pointer-events-none flex flex-col items-center gap-3">
            {messages.slice(-2).map((m) => (
              <div key={m.id} className="bg-black/80 backdrop-blur-xl px-5 py-3 rounded-2xl border border-white/10 max-w-[85%]">
                <p className="text-[17px] font-medium text-center">{m.translatedText || ""}</p>
              </div>
            ))}
          </div>
        )}

        {/* PHONE PTT RING - Only visible on Mobile */}
        {isMobile && (
          <div className="absolute inset-x-0 bottom-12 flex justify-center z-30">
            <button
              onPointerDown={handlePttStart}
              onPointerUp={handlePttEnd}
              onPointerLeave={handlePttEnd}
              className={`w-28 h-28 rounded-full border-4 transition-all flex items-center justify-center ${
                isTalking ? "bg-emerald-500 border-emerald-300 scale-110 shadow-[0_0_40px_rgba(16,185,129,0.6)]" : "bg-transparent border-white/30"
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
        onExit={handleExit} 
      />

      <BottomRightHud 
        visible={brVisible} 
        isMobile={isMobile} // This prop hides Mic Toggle on Phone
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
