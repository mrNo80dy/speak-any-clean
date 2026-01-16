"use client";

import React from "react";

type Props = {
  onWakeTop: () => void;
  onWakeBottomRight: () => void;
};

export function HudWakeZones({ onWakeTop, onWakeBottomRight }: Props) {
  return (
    <>
      {/* TOP WAKE ZONE - Lower Z-Index (10) so it doesn't block buttons (30+) */}
      <div
        className="fixed top-0 left-0 right-0 z-10 pointer-events-auto"
        style={{ height: "30vh", background: "transparent", touchAction: "manipulation" }}
        onPointerDown={() => {
          onWakeTop();
        }}
      />

      {/* BOTTOM-RIGHT WAKE ZONE */}
      <div
        className="fixed right-0 bottom-0 z-10 pointer-events-auto"
        style={{
          width: 150,
          height: 210,
          background: "transparent",
          touchAction: "manipulation",
        }}
        onPointerDown={() => {
          onWakeBottomRight();
        }}
      />
    </>
  );
}
