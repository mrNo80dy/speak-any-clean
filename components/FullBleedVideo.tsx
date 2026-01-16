"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type FitMode = "cover" | "contain" | "auto";

export default function FullBleedVideo({
  stream,
  isLocal = false,
  fit = "auto",
  preferCoverOnMobilePortrait = true,
  className = "",
}: {
  stream: MediaStream | null;
  isLocal?: boolean;
  fit?: FitMode;
  preferCoverOnMobilePortrait?: boolean;
  className?: string;
}) {
  const bgRef = useRef<HTMLVideoElement | null>(null);
  const fgRef = useRef<HTMLVideoElement | null>(null);
  const cloneRef = useRef<MediaStream | null>(null);

  const [isMobilePortrait, setIsMobilePortrait] = useState(false);
  const [isPortraitStream, setIsPortraitStream] = useState(false);
  // This state is used specifically to "kick" the component when tracks enable
  const [, setTick] = useState(0); 

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const update = () => {
      const portrait = window.innerHeight >= window.innerWidth;
      setIsMobilePortrait(isMobileUa && portrait);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useEffect(() => {
    const s = stream;
    if (!s) return;

    const bg = bgRef.current;
    const fg = fgRef.current;

    // FIX: Listen for tracks being enabled/disabled
    // This solves the "light on but black screen" issue
    const tracks = s.getVideoTracks();
    const handleTrackChange = () => setTick(t => t + 1);

    tracks.forEach(t => {
      t.addEventListener('mute', handleTrackChange);
      t.addEventListener('unmute', handleTrackChange);
    });

    if (!cloneRef.current || cloneRef.current.getTracks().length !== tracks.length) {
      cloneRef.current = new MediaStream(tracks);
    }

    if (bg && bg.srcObject !== cloneRef.current) {
      bg.srcObject = cloneRef.current;
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
        t.removeEventListener('mute', handleTrackChange);
        t.removeEventListener('unmute', handleTrackChange);
      });
    };
  }, [stream]);

  const resolvedFit = useMemo(() => {
    if (fit === "cover" || fit === "contain") return fit;
    if (preferCoverOnMobilePortrait && isMobilePortrait) return "cover";
    return "contain";
  }, [fit, preferCoverOnMobilePortrait, isMobilePortrait]);

  const mirrorStyle = isLocal ? ({ transform: "scaleX(-1)" } as const) : undefined;

  return (
    <div className={"absolute inset-0 bg-black overflow-hidden " + className}>
      <video
        ref={bgRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover blur-xl scale-110 opacity-40"
      />
      <video
        ref={fgRef}
        autoPlay
        playsInline
        muted
        style={mirrorStyle}
        className={`absolute inset-0 h-full w-full transition-opacity duration-500 ${stream ? 'opacity-100' : 'opacity-0'} ${
          resolvedFit === "cover" ? "object-cover" : "object-contain"
        }`}
      />
    </div>
  );
}
