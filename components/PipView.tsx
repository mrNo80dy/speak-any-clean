"use client";

import React, { useEffect, useMemo, useRef } from "react";

type Props = {
  stream: MediaStream | null;
  isMobile: boolean;
  /** Whether PiP is currently shown */
  visible: boolean;
  /** Whether PiP controls are currently visible (not faded out) */
  controlsVisible: boolean;
  /** Called when user taps/clicks the PiP area to wake controls */
  onWakeControls: () => void;
  /** Hide PiP (user can tap outline to bring it back) */
  onHide?: () => void;
  /** Optional camera flip handler (mobile only) */
  onFlipCamera?: () => Promise<void>;
  /** Extra pixels above safe-area inset */
  bottomOffset?: number;
};

function EyeOffIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      className="opacity-90"
      aria-hidden="true"
    >
      <path d="M3 3l18 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M10.58 10.58a2 2 0 0 0 2.83 2.83"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M9.87 5.09A10.94 10.94 0 0 1 12 5c5 0 9.27 3.11 11 7-0.58 1.31-1.43 2.5-2.5 3.5M6.61 6.61C4.62 7.95 3.1 9.86 2 12c1.73 3.89 6 7 10 7 1.1 0 2.16-0.15 3.16-0.43"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FlipIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      className="opacity-90"
      aria-hidden="true"
    >
      <path
        d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-6.36 2.64"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M3 3v6h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path
        d="M3 12a9 9 0 0 0 9 9 9 9 0 0 0 6.36-2.64"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path d="M21 21v-6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export function PipView({
  stream,
  isMobile,
  visible,
  controlsVisible,
  onWakeControls,
  onHide,
  onFlipCamera,
  bottomOffset = 12,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Stable key for stream identity changes (helps when stream toggles / tracks restart)
  const streamKey = useMemo(() => {
    const id = stream?.id || "";
    const v = stream?.getVideoTracks?.()[0];
    const vid = (v?.getSettings?.() as MediaTrackSettings | undefined)?.deviceId || "";
    return `${id}::${vid}::${v?.id || ""}`;
  }, [stream]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    // If PiP is hidden, pause to avoid showing stale frame.
    if (!visible) {
      try {
        el.pause?.();
      } catch {}
      return;
    }

    if (!stream) return;

    try {
      // Re-assign to force refresh when we re-show
      el.srcObject = stream;
      const p = el.play?.();
      if (p && typeof (p as any).catch === "function") (p as any).catch(() => {});
    } catch {}
  }, [stream, streamKey, visible]);

  const bottomStyle = `calc(env(safe-area-inset-bottom) + ${bottomOffset}px)`;

  // Controls should not be clickable when faded/hidden.
  const controlsPointer = controlsVisible ? "pointer-events-auto" : "pointer-events-none";
  const controlsOpacity = controlsVisible ? "opacity-100" : "opacity-[0.25]";

  if (!stream) return null;

  // ---- SIZE (tuned smaller) -------------------------------
  // Keep the same “portrait” feel on mobile but make it less intrusive.
  const boxStyle = {
    width: isMobile ? 120 : 160,
    height: isMobile ? 188 : 106,
  } as const;

  return (
    <div
      className="fixed z-[60] pointer-events-auto"
      style={{ left: 12, bottom: bottomStyle }}
      onPointerDown={(e) => {
        // Wake controls on any tap/click inside the PiP area
        e.stopPropagation();
        onWakeControls();
      }}
    >
      <div className="relative" style={boxStyle}>
        {/* The actual video box (hidden when not visible) */}
        <div
          className={[
            "absolute inset-0 overflow-hidden rounded-2xl shadow-lg",
            "bg-black",
            visible ? "opacity-100" : "opacity-0",
          ].join(" ")}
          style={{ transition: "opacity 220ms ease" }}
        >
          <video
            key={streamKey}
            ref={videoRef}
            muted
            playsInline
            autoPlay
            className="h-full w-full object-cover"
          />
        </div>

        {/* Transparent outline tap area when PiP is hidden */}
        {!visible && <div className="absolute inset-0 rounded-2xl border border-white/35 bg-transparent" />}

        {/* Controls overlay bottom-left (always fades; wakes on tap) */}
        <div
          className={[
            "absolute left-2 bottom-2 flex items-center gap-2",
            controlsPointer,
            controlsOpacity,
          ].join(" ")}
          style={{ transition: "opacity 220ms ease" }}
        >
          {onHide && (
            <button
              type="button"
              className="h-10 w-10 rounded-full bg-black/45 backdrop-blur flex items-center justify-center"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onHide();
              }}
            >
              <EyeOffIcon />
            </button>
          )}

          {isMobile && onFlipCamera && (
            <button
              type="button"
              className="h-10 w-10 rounded-full bg-black/45 backdrop-blur flex items-center justify-center"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                void onFlipCamera();
              }}
            >
              <FlipIcon />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
