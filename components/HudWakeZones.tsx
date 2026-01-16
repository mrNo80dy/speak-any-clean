"use client";

import React from "react";

type Props = {
  onWakeTop: () => void;
  onWakeBottomRight: () => void;
};

export function HudWakeZones({ onWakeTop, onWakeBottomRight }: Props) {
  return (
    <>
      {/* TOP WAKE ZONE (top ~30% of screen) */}
      <div
        className="absolute top-0 left-0 right-0 z-10 pointer-events-auto"
        style={{ height: "30vh" }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onWakeTop();
        }}
      />

      {/* BOTTOM-RIGHT WAKE ZONE (corner, PiP-sized) */}
      <div
        className="fixed right-0 bottom-0 z-10 pointer-events-auto"
        style={{
          width: 140,
          height: 200,
        }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onWakeBottomRight();
        }}
      />
    </>
  );
}
