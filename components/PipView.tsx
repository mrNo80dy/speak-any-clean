"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  stream: MediaStream | null;
  isMobile: boolean;
  visible: boolean;
  controlsVisible: boolean;
  pinned: boolean;
  onWakeControls: () => void;
  onTogglePin: () => void;
  onFlipCamera?: () => void;
};

export function PipView({
  stream,
  isMobile,
  visible,
  controlsVisible,
  pinned,
  onWakeControls,
  onTogglePin,
  onFlipCamera,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // On many browsers a tap triggers both pointer events and a click.
  // Without a guard, pin/flip can toggle twice (looks like "doesn't work").
  const skipNextClickRef = useRef(false);

  // Track viewport so PiP can size correctly on orientation changes.
  const [viewport, setViewport] = useState<{ w: number; h: number }>(() => {
    if (typeof window === "undefined") return { w: 0, h: 0 };
    return { w: window.innerWidth, h: window.innerHeight };
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Keep the PiP container matched to the *actual* camera aspect ratio.
  // Default: portrait-ish on mobile, landscape on desktop.
  const [aspect, setAspect] = useState<number>(() => (isMobile ? 9 / 16 : 16 / 9));

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Update aspect ratio once metadata is available (videoWidth/videoHeight).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const update = () => {
      const vw = el.videoWidth || 0;
      const vh = el.videoHeight || 0;
      if (vw > 0 && vh > 0) setAspect(vw / vh);
    };

    el.addEventListener("loadedmetadata", update);
    el.addEventListener("resize", update as any);
    // In case metadata is already there
    update();
    return () => {
      el.removeEventListener("loadedmetadata", update);
      el.removeEventListener("resize", update as any);
    };
  }, [stream]);

  // Responsive PiP sizing (matched to camera aspect; avoids cutting you off)
  const pipStyle = useMemo(() => {
    // Use viewport state (updates on rotate) instead of window lookups.
    const w = viewport.w;
    const h = viewport.h;
    if (w <= 0 || h <= 0) return {};

    const isLandscape = w > h;
    const arRaw = aspect || (isMobile ? 9 / 16 : 16 / 9);
    // On mobile portrait, some devices report a landscape track (vw>vh) even though
    // the user is holding the phone vertically. For PiP, we prefer a portrait-shaped box.
    const ar = isMobile && !isLandscape && arRaw > 1.05 ? 1 / arRaw : arRaw;

    if (!isMobile) {
      // Desktop: size from width.
      const width = 240;
      return { width, aspectRatio: `${ar}`, maxHeight: 260 } as React.CSSProperties;
    }

    // Mobile sizing:
    // - Portrait: size from HEIGHT first so the preview isn't "short".
    // - Landscape: size from WIDTH first so it doesn't cover too much.
    if (!isLandscape) {
      const targetH = Math.max(160, Math.min(Math.round(h * 0.28), 260));
      const maxW = Math.max(140, Math.min(Math.round(w * 0.42), 220));
      const rawW = Math.round(targetH * ar);
      const scale = rawW > maxW ? maxW / rawW : 1;
      const hFinal = Math.round(targetH * scale);
      const wFinal = Math.round(rawW * scale);
      return { width: wFinal, height: hFinal, aspectRatio: `${ar}` } as React.CSSProperties;
    }

    const targetW = Math.max(150, Math.min(Math.round(w * 0.34), 220));
    const maxH = Math.max(140, Math.min(Math.round(h * 0.42), 220));
    const rawH = Math.round(targetW / ar);
    const scale = rawH > maxH ? maxH / rawH : 1;
    const wFinal = Math.round(targetW * scale);
    const hFinal = Math.round(rawH * scale);
    return { width: wFinal, height: hFinal, aspectRatio: `${ar}` } as React.CSSProperties;
  }, [isMobile, aspect, viewport]);

  if (!stream) return null;

  // When not visible (not pinned and asleep), show a small "handle" so the user can bring PiP back.
  if (!visible) {
    return (
      <button
        type="button"
        className="fixed left-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-50 w-11 h-11 rounded-full bg-black/40 backdrop-blur text-white flex items-center justify-center pointer-events-auto"
        aria-label="Show PiP"
        onPointerDown={(e) => {
          e.stopPropagation();
          onWakeControls();
        }}
      >
        📷
      </button>
    );
  }

  return (
    <div
      className="fixed left-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-50 pointer-events-auto"
      style={pipStyle}
      onPointerDown={(e) => {
        // If the user is pressing a control button, do NOT treat it as a wake-tap.
        // This avoids the common mobile issue where the container handler swallows the button tap.
        const t = e.target as HTMLElement;
        if (t?.closest?.("[data-pip-control='1']")) return;
        e.stopPropagation();
        onWakeControls();
      }}
    >
      <div className="relative w-full h-full overflow-hidden rounded-none bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.10)]">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          // Use contain so your face/body isn't cropped in portrait.
          className="w-full h-full object-contain rounded-none bg-black"
        />

        {/* PiP controls */}
        {(controlsVisible || pinned) && (
          <div className="absolute inset-0 flex flex-col items-end p-2 gap-2">
            <button
              type="button"
              data-pip-control="1"
              onPointerDown={(e) => {
                e.stopPropagation();
                skipNextClickRef.current = true;
                onTogglePin();
                // If this browser doesn't emit a click after pointerdown, clear the guard.
                window.setTimeout(() => {
                  skipNextClickRef.current = false;
                }, 250);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (skipNextClickRef.current) {
                  skipNextClickRef.current = false;
                  return;
                }
                onTogglePin();
              }}
              title={pinned ? "Unpin PiP" : "Pin PiP"}
              aria-label="Pin PiP"
              className="w-10 h-10 flex items-center justify-center text-white text-lg bg-black/40 backdrop-blur border border-white/10 rounded-full shadow-sm opacity-95 active:scale-[0.98]"
            >
              {pinned ? "📌" : "📍"}
            </button>

            {onFlipCamera && (
              <button
                type="button"
                data-pip-control="1"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  skipNextClickRef.current = true;
                  onFlipCamera();
                  window.setTimeout(() => {
                    skipNextClickRef.current = false;
                  }, 250);
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (skipNextClickRef.current) {
                    skipNextClickRef.current = false;
                    return;
                  }
                  onFlipCamera();
                }}
                title="Flip camera"
                aria-label="Flip camera"
                className="w-10 h-10 flex items-center justify-center text-white text-lg bg-black/40 backdrop-blur border border-white/10 rounded-full shadow-sm opacity-95 active:scale-[0.98]"
              >
                ↺
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
