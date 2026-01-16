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

  const clientId = useMemo(() => {
    if (typeof window === "undefined") return "server";
    let id = sessionStorage.getItem("as_client_id");
    if (!id) {
      id = crypto.randomUUID();
      sessionStorage.setItem("as_client_id", id);
    }
    return id;
  }, []);

  const [ccOn, setCcOn] = useState(true);
  const [showTextInput, setShowTextInput] = useState(false);
  const [streamVersion, setStreamVersion] = useState(0);

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

  const { 
    toggleCamera, 
    hdEnabled, 
    setVideoQuality 
  } = useCamera({
    isMobile: false, 
    roomType: "video",
    acquire,
    localStreamRef,
    setCamEnabled,
    joinCamOn: true
  });

  // Start Media on Mount
  useEffect(() => {
    if (!roomId) return;
    const init = async () => {
      try {
        await acquire();
        // Force a reset "blink" to ensure the video element binds to the stream
        setCamEnabled(false);
        setMicEnabled(true);
        setTimeout(() => {
          setCamEnabled(true);
          setStreamVersion(v => v + 1);
        }, 150);
      } catch (e) {
        console.error("Failed to acquire media", e);
      }
    };
    init();
    return () => stop();
  }, [roomId, acquire, setCamEnabled, setMicEnabled, stop]);

  const handleExit = useCallback(() => {
    stop();
    router.push("/");
  }, [router, stop]);

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

        {/* CC Overlay - Fixed property name error */}
        {ccOn && messages.length > 0 && (
          <div className="absolute inset-x-0 bottom-32 px-6 z-20 pointer-events-none flex flex-col items-center gap-3">
            {messages.slice(-2).map((m) => (
              <div 
                key={m.id} 
                className="bg-black/70 backdrop-blur-xl px-5 py-3 rounded-2xl border border-white/10 max-w-[85%] animate-in fade-in slide-in-from-bottom-2 duration-300"
              >
                <p className="text-[17px] font-medium leading-snug text-center text-white drop-shadow-md">
                  {/* Using m.translatedText primarily, falling back to an empty string if undefined to satisfy TS */}
                  {m.translatedText || ""}
                </p>
              </div>
            ))}
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
        isMobile={false} 
        camOn={camOn} 
        micOn={micOn} 
        showTextInput={showTextInput} 
        onToggleCamera={toggleCamera} 
        onToggleMic={() => setMicEnabled(!micOn)} 
        onToggleText={() => setShowTextInput(!showTextInput)} 
      />

      {showTextInput && (
        <div className="absolute inset-x-0 bottom-24 px-4 z-40 flex justify-center">
           <div className="bg-white/10 backdrop-blur-lg p-2 rounded-full border border-white/20 w-full max-w-md">
              <input 
                autoFocus
                className="bg-transparent w-full px-4 py-2 outline-none text-white placeholder:text-white/40"
                placeholder="Type a message..."
                onKeyDown={(e) => { if (e.key === 'Enter') setShowTextInput(false); }}
              />
           </div>
        </div>
      )}
    </div>
  );
}
