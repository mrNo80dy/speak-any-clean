"use client";

import React, { useEffect, useMemo, useRef } from "react";

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

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  // Responsive PiP sizing (fixes landscape shrink)
  const pipStyle = useMemo(() => {
    if (typeof window === "undefined") return {};

    const w = window.innerWidth;
    const h = window.innerHeight;
    const isLandscape = w > h;
    const base = Math.min(w, h);
    
const size = isMobile
  ? isLandscape
    ? Math.min(base * 0.52, 260) // landscape bigger
    : Math.min(base * 0.28, 165) // portrait smaller
  : 220;


    return {
      width: size,
      height: Math.round(size * 0.75),
    };
  }, [isMobile]);

  if (!visible || !stream) return null;

  return (
    <div
  className="fixed left-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-50 pointer-events-auto"
  style={pipStyle}
  onPointerDown={(e) => {
    e.stopPropagation();
    onWakeControls();
  }}
>

      <div className="relative w-full h-full">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-full h-full object-cover rounded-lg bg-black"
        />

        {/* PiP controls */}
        {(controlsVisible || pinned) && (
          <div className="absolute inset-0 flex flex-col items-end p-2 gap-2">
            <button
              type="button"
              onClick={onTogglePin}
              title={pinned ? "Unpin PiP" : "Pin PiP"}
              aria-label="Pin PiP"
              className="w-9 h-9 flex items-center justify-center text-white text-lg bg-transparent border-0 rounded-none shadow-none appearance-none opacity-90 hover:opacity-100"
            >
              📌
            </button>

            {onFlipCamera && (
              <button
                type="button"
                onClick={onFlipCamera}
                title="Flip camera"
                aria-label="Flip camera"
                className="w-9 h-9 flex items-center justify-center text-white text-lg bg-transparent border-0 rounded-none shadow-none appearance-none opacity-90 hover:opacity-100"
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
