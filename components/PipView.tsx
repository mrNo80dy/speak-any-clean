"use client";

import React, { useEffect, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  isMobile: boolean;
  visible: boolean;
  controlsVisible: boolean;

  // Called when the user taps/clicks the PiP area to wake controls.
  onWakeControls: () => void;

  // Optional: hide PiP (your new "pin hides PiP" behavior).
  onHide?: () => void;

  // Optional: legacy pin toggle (kept for compatibility).
  pinned?: boolean;
  onTogglePin?: () => void;

  // Optional: flip camera (mobile only).
  onFlipCamera?: () => Promise<void>;
};

export function PipView({
  stream,
  isMobile,
  visible,
  controlsVisible,
  onWakeControls,
  onHide,
  pinned,
  onTogglePin,
  onFlipCamera,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Keep srcObject attached (and re-attach after hide/show to avoid black video).
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    if (!visible) {
      // Detach when hidden so the browser doesn't keep a stale rendering surface.
      try {
        (el as any).srcObject = null;
      } catch {}
      return;
    }

    try {
      (el as any).srcObject = stream ?? null;
    } catch {}

    // Try to play (especially important on Android Chrome after re-attach).
    const p = el.play?.();
    if (p && typeof (p as any).catch === "function") (p as any).catch(() => {});
  }, [stream, visible]);

  if (!visible) return null;

  const handlePin = () => {
    // Prefer new behavior
    if (onHide) return onHide();
    // Fallback legacy
    if (onTogglePin) return onTogglePin();
  };

  return (
    <div
      className="pointer-events-auto select-none"
      onClick={(e) => {
        e.stopPropagation();
        onWakeControls();
      }}
      onTouchStart={(e) => {
        e.stopPropagation();
        onWakeControls();
      }}
      style={{
        position: "absolute",
        left: 16,
        bottom: isMobile ? 110 : 16,
        width: isMobile ? 130 : 220,
        height: isMobile ? 220 : 124,
        borderRadius: 12,
        overflow: "hidden",
        background: "rgba(0,0,0,0.35)",
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
      }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: "scaleX(-1)",
        }}
      />

      {/* Controls overlay (bottom-left) */}
      <div
        style={{
          position: "absolute",
          left: 8,
          bottom: 8,
          display: "flex",
          gap: 8,
          opacity: controlsVisible ? 1 : 0,
          pointerEvents: controlsVisible ? "auto" : "none",
          transition: "opacity 160ms ease",
        }}
      >
        <button
          type="button"
          aria-label="Hide PiP"
          onClick={(e) => {
            e.stopPropagation();
            handlePin();
          }}
          className="rounded-full"
          style={{
            width: 42,
            height: 42,
            background: "rgba(0,0,0,0.55)",
            color: "white",
            border: "1px solid rgba(255,255,255,0.18)",
          }}
        >
          {pinned ? "PIN" : "HIDE"}
        </button>

        {onFlipCamera && (
          <button
            type="button"
            aria-label="Flip camera"
            onClick={(e) => {
              e.stopPropagation();
              onFlipCamera?.();
            }}
            className="rounded-full"
            style={{
              width: 42,
              height: 42,
              background: "rgba(0,0,0,0.55)",
              color: "white",
              border: "1px solid rgba(255,255,255,0.18)",
              fontSize: 16,
            }}
          >
            ↻
          </button>
        )}
      </div>
    </div>
  );
}

export default PipView;
