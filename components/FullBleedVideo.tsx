"use client";

import { useEffect, useRef, useState } from "react";

export default function FullBleedVideo({ stream, isLocal = false, fit = "cover", className = "" }: { stream: MediaStream | null; isLocal?: boolean; fit?: "cover" | "contain"; className?: string; }) {
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const fgRef = useRef<HTMLVideoElement | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!stream) return;
    const bg = bgRef.current;
    const fg = fgRef.current;

    const handleTrackChange = () => {
      setTick(t => t + 1);
      if (fg) fg.play().catch(() => {});
    };

    stream.getVideoTracks().forEach(t => {
      t.addEventListener('unmute', handleTrackChange);
      t.addEventListener('mute', handleTrackChange);
    });

    if (bg && bg.srcObject !== stream) { bg.srcObject = stream; bg.muted = true; bg.play().catch(() => {}); }
    if (fg && fg.srcObject !== stream) { fg.srcObject = stream; fg.muted = true; fg.play().catch(() => {}); }

    return () => {
      stream.getVideoTracks().forEach(t => {
        t.removeEventListener('unmute', handleTrackChange);
        t.removeEventListener('mute', handleTrackChange);
      });
    };
  }, [stream]);

  const mirrorStyle = isLocal ? { transform: "scaleX(-1)" } : undefined;

  return (
    <div className={"absolute inset-0 bg-black overflow-hidden " + className}>
      <video ref={bgRef} autoPlay playsInline muted className="absolute inset-0 h-full w-full object-cover blur-xl scale-110 opacity-40" />
      <video ref={fgRef} autoPlay playsInline muted style={mirrorStyle} className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${stream ? 'opacity-100' : 'opacity-0'} ${fit === "cover" ? "object-cover" : "object-contain"}`} />
    </div>
  );
}
