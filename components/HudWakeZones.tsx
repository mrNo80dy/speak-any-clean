"use client";

import React from "react";

type Props = {
  onWakeTop: () => void;
  onWakeBottomRight: () => void;
};

export function HudWakeZones({ onWakeTop, onWakeBottomRight }: Props) {
  return (
    <>
      {/* TOP WAKE ZONE (tap only) */}
      <div
        className="fixed top-0 left-0 right-0 z-[60] pointer-events-auto"
        style={{ height: "30vh", background: "transparent", touchAction: "manipulation" }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onWakeTop();
        }}
      />

      {/* BOTTOM-RIGHT WAKE ZONE (tap only, PiP-sized) */}
      <div
        className="fixed right-0 bottom-0 z-[60] pointer-events-auto"
        style={{
          width: 150,
          height: 210,
          background: "transparent",
          touchAction: "manipulation",
        }}
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onWakeBottomRight();
        }}
      />
    </>
  );
}
