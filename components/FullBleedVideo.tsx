"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type FitMode = "cover" | "contain" | "auto";

export default function FullBleedVideo({
  stream,
  isLocal = false,
  fit = "auto",
  // When fit="auto": if viewer is mobile portrait AND the stream is portrait, we use cover; otherwise contain.
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

  // Detect mobile + portrait viewport
  useEffect(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;
    const isMobileUa = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    const update = () => {
      const portrait = window.matchMedia?.("(orientation: portrait)")?.matches ?? (window.innerHeight >= window.innerWidth);
      setIsMobilePortrait(isMobileUa && portrait);
    };

    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // Detect stream orientation from track settings
  useEffect(() => {
    const s = stream || null;
    if (!s) {
      setIsPortraitStream(false);
      return;
    }
    const vt = s.getVideoTracks?.()[0];
    const st = (vt?.getSettings?.() ?? {}) as any;
    const w = Number(st.width || 0);
    const h = Number(st.height || 0);
    const ar = Number(st.aspectRatio || 0);

    // Prefer explicit width/height; fallback to aspectRatio
    const portrait =
      (w > 0 && h > 0 ? h >= w : ar > 0 ? ar < 1 : false);

    setIsPortraitStream(!!portrait);
  }, [stream]);

  // Attach streams
  useEffect(() => {
    const s = stream || null;
    const fg = fgRef.current;
    const bg = bgRef.current;

    if (!s) {
      if (fg) fg.srcObject = null;
      if (bg) bg.srcObject = null;
      return;
    }

    // Lightweight clone for blurred background layer
    const tracks = s.getTracks();
    if (!cloneRef.current || cloneRef.current.getTracks().length !== tracks.length) {
      cloneRef.current = new MediaStream(tracks);
    }

    if (bg && bg.srcObject !== cloneRef.current) {
      bg.srcObject = cloneRef.current;
      bg.playsInline = true as any;
      bg.muted = true;
      bg.play().catch(() => {});
    }

    if (fg && fg.srcObject !== s) {
      fg.srcObject = s;
      fg.playsInline = true as any;
      fg.muted = true;
      fg.play().catch(() => {});
    }
  }, [stream]);

  const resolvedFit: "cover" | "contain" = useMemo(() => {
    if (fit === "cover" || fit === "contain") return fit;
    // auto:
    if (preferCoverOnMobilePortrait && isMobilePortrait && isPortraitStream) return "cover";
    return "contain";
  }, [fit, preferCoverOnMobilePortrait, isMobilePortrait, isPortraitStream]);

  const mirrorStyle = isLocal ? ({ transform: "scaleX(-1)" } as const) : undefined;

  return (
    <div className={"absolute inset-0 bg-black overflow-hidden " + className}>
      {/* Background fill */}
      <video
        ref={bgRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 h-full w-full object-cover blur-xl scale-110 opacity-40"
      />

      {/* Foreground */}
      <video
        ref={fgRef}
        autoPlay
        playsInline
        muted
        data-local={isLocal ? "1" : undefined}
        className={"absolute inset-0 h-full w-full " + (resolvedFit === "cover" ? "object-cover" : "object-contain")}
        style={mirrorStyle}
      />
    </div>
  );
}
