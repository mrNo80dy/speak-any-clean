"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type FitMode = "cover" | "contain" | "auto";

export default function FullBleedVideo({
  stream,
  isLocal = false,
  fit = "auto",
  className = "",
}: {
  stream: MediaStream | null;
  isLocal?: boolean;
  fit?: FitMode;
  className?: string;
}) {
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const fgRef = useRef<HTMLVideoElement | null>(null);
  
  // This "tick" forces a refresh when tracks enable/disable
  const [, setTick] = useState(0); 

  useEffect(() => {
    const s = stream;
    if (!s) return;

    const bg = bgRef.current;
    const fg = fgRef.current;

    const tracks = s.getVideoTracks();
    
    // FIX: Listen for 'unmute' (when camera actually starts sending data)
    const handleTrackChange = () => {
      setTick(t => t + 1);
      if (fg) fg.play().catch(() => {});
    };

    tracks.forEach(t => {
      t.addEventListener('unmute', handleTrackChange);
      t.addEventListener('mute', handleTrackChange);
    });

    if (bg && bg.srcObject !== s) {
      bg.srcObject = s;
      bg.muted = true;
      bg.play().catch(() => {});
    }

    if (fg && fg.srcObject !== s) {
      fg.srcObject = s;
      fg.muted = true;
      fg.play().catch(() => {});
    }

    return () => {
      tracks.forEach(t => {
        t.removeEventListener('unmute', handleTrackChange);
        t.removeEventListener('mute', handleTrackChange);
      });
    };
  }, [stream]);

  const mirrorStyle = isLocal ? ({ transform: "scaleX(-1)" } as const) : undefined;

  return (
    <div className={"absolute inset-0 bg-black overflow-hidden " + className}>
      <video
        ref={bgRef}
        autoPlay playsInline muted
        className="absolute inset-0 h-full w-full object-cover blur-xl scale-110 opacity-40"
      />
      <video
        ref={fgRef}
        autoPlay playsInline muted
        style={mirrorStyle}
        className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${stream ? 'opacity-100' : 'opacity-0'} ${
          fit === "cover" ? "object-cover" : "object-contain"
        }`}
      />
    </div>
  );
}
