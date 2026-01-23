"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  bottomOffset?: number;
  stream: MediaStream | null;
  isMobile: boolean;
  pinned: boolean;
  visible: boolean; // whether PiP is currently shown (vs "sleeping" outline only)
  controlsVisible: boolean;
  onTogglePin: () => void;
  onWakeControls: () => void;
  onFlipCamera?: () => void;
};

function PipView({
  bottomOffset = 0,
  stream,
  isMobile,
  pinned,
  visible,
  controlsVisible,
  onTogglePin,
  onWakeControls,
  onFlipCamera,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [aspect, setAspect] = useState<number>(0);
  const [viewport, setViewport] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Keep a cheap viewport state so PiP sizing updates on rotate / resize without reflow hacks.
  useEffect(() => {
    const read = () => {
      try {
        const w = window.innerWidth || 0;
        const h = window.innerHeight || 0;
        setViewport({ w, h });
      } catch {}
    };
    read();
    window.addEventListener("resize", read, { passive: true } as any);
    window.addEventListener("orientationchange", read, { passive: true } as any);
    return () => {
      window.removeEventListener("resize", read as any);
      window.removeEventListener("orientationchange", read as any);
    };
  }, []);

  // Attach stream to <video> and keep track aspect ratio.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    try {
      (el as any).srcObject = stream || null;
    } catch {}

    const update = () => {
      try {
        const vw = Number((el as any).videoWidth || 0);
        const vh = Number((el as any).videoHeight || 0);
        if (vw > 0 && vh > 0) setAspect(vw / vh);
      } catch {}
    };

    const kickPlay = async () => {
      // Some mobile browsers need an explicit play() even when autoPlay is set.
      try {
        await el.play();
      } catch {}
    };

    el.addEventListener("loadedmetadata", update);
    el.addEventListener("resize", update as any);
    // In case metadata is already there
    update();
    kickPlay();

    return () => {
      el.removeEventListener("loadedmetadata", update);
      el.removeEventListener("resize", update as any);
    };
  }, [stream]);

  // Also try to resume playback when we wake PiP (user gesture helps on mobile).
  const wake = async (e?: any) => {
    try {
      e?.stopPropagation?.();
    } catch {}
    onWakeControls();
    const el = videoRef.current;
    if (el) {
      try {
        await el.play();
      } catch {}
    }
  };

  // Responsive PiP sizing (matched to camera aspect; avoids cutting you off)
  const pipStyle = useMemo(() => {
    const w = viewport.w;
    const h = viewport.h;
    if (w <= 0 || h <= 0) return {};

    const isLandscape = w > h;
    const arRaw = aspect || (isMobile ? 9 / 16 : 16 / 9);

    // On mobile portrait, some devices report a landscape track even though the phone is vertical.
    // For PiP, prefer a portrait-shaped box.
    const ar = isMobile && !isLandscape && arRaw > 1.05 ? 1 / arRaw : arRaw;

    if (!isMobile) {
      const width = 240;
      return { width, aspectRatio: `${ar}`, maxHeight: 260 } as React.CSSProperties;
    }

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

  const style = {
    ...(pipStyle || {}),
    bottom: `calc(env(safe-area-inset-bottom) + 12px + ${bottomOffset}px)`,
  } as React.CSSProperties;

  // If style isn't ready yet (e.g., first render before viewport measured), fall back to a small handle.
  const hasSize =
    typeof (style as any).width !== "undefined" ||
    typeof (style as any).height !== "undefined" ||
    typeof (style as any).aspectRatio !== "undefined";

  const containerStyle: React.CSSProperties = hasSize ? style : { bottom: style.bottom, width: 64, height: 64 };

  return (
    <div
      className="fixed left-3 z-50 pointer-events-auto"
      style={containerStyle}
      role={!visible ? "button" : undefined}
      aria-label={!visible ? "Show PiP" : undefined}
      tabIndex={!visible ? 0 : undefined}
      onPointerDown={(e) => {
        // If the user is pressing a control button, do NOT treat it as a wake-tap.
        const t = e.target as HTMLElement;
        if (t?.closest?.("[data-pip-control='1']")) return;
        wake(e);
      }}
      onClick={(e) => {
        if (!visible) wake(e);
      }}
      onKeyDown={(e) => {
        if (!visible && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          wake(e);
        }
      }}
    >
      {/* Outline tap-area when PiP is sleeping (no icon) */}
      {!visible && <div className="absolute inset-0 rounded-lg border border-white/25 bg-transparent" />}

      <div
        className="relative w-full h-full overflow-hidden rounded-none bg-black shadow-[0_0_0_1px_rgba(255,255,255,0.10)]"
        style={{ opacity: visible ? 1 : 0, transition: "opacity 250ms ease" }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-contain rounded-none bg-black"
        />

        {/* PiP controls */}
        {(controlsVisible || pinned) && visible && (
          <div className="absolute inset-0 flex flex-col items-end p-2 gap-2">
            <button
              type="button"
              data-pip-control="1"
              onClick={(e) => {
                e.stopPropagation();
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
                onClick={(e) => {
                  e.stopPropagation();
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

// Export both default and named to avoid import mismatches across the app.
export { PipView };
export default PipView;
