"use client";

import React from "react";

type Props = {
  onWakeTop: () => void;
  onWakeBottomRight: () => void;
};

export function HudWakeZones({ onWakeTop, onWakeBottomRight }: Props) {
  return (
    <>
      {/* Z-10 ensures this is ABOVE the video (z-0) 
          but BELOW the interactive HUD buttons (z-30+)
      */}
      <div
        className="fixed top-0 left-0 right-0 z-10"
        style={{ height: "30vh", background: "transparent" }}
        onPointerDown={() => onWakeTop()}
      />

      <div
        className="fixed right-0 bottom-0 z-10"
        style={{
          width: 150,
          height: 210,
          background: "transparent",
        }}
        onPointerDown={() => onWakeBottomRight()}
      />
    </>
  );
}
