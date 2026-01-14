"use client";

import React from "react";

type Props = {
  visible: boolean;
  ccOn: boolean;
  onToggleCc: () => void;
  hdEnabled: boolean;
  onToggleHd: () => void;
  onShare: () => void;
  onExit: () => void;
};

export default function RoomTopControls({
  visible,
  ccOn,
  onToggleCc,
  hdEnabled,
  onToggleHd,
  onShare,
  onExit,
}: Props) {
  return (
    <div
      className={`absolute top-3 left-0 right-0 z-50 flex justify-center pointer-events-none transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="pointer-events-auto flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleCc}
          className={`w-11 h-11 rounded-2xl border border-white/10 backdrop-blur-md shadow text-white/90 flex items-center justify-center ${
            ccOn ? "bg-white/20" : "bg-black/30"
          }`}
          aria-label="Toggle captions"
          title="Captions"
        >
          CC
        </button>

        <button
          type="button"
          onClick={onToggleHd}
          className="w-11 h-11 rounded-2xl bg-black/30 border border-white/10 backdrop-blur-md shadow text-white/90 flex items-center justify-center"
          aria-label={hdEnabled ? "Switch to SD" : "Switch to HD"}
          title={hdEnabled ? "HD" : "SD"}
        >
          {hdEnabled ? "HD" : "SD"}
        </button>

        <button
          type="button"
          onClick={onShare}
          className="w-11 h-11 rounded-2xl bg-black/30 border border-white/10 backdrop-blur-md shadow text-white/90 flex items-center justify-center"
          aria-label="Share room link"
          title="Share"
        >
          ↗
        </button>

        <button
          type="button"
          onClick={onExit}
          className="w-11 h-11 rounded-2xl bg-[#b30d0d]/80 border border-white/10 backdrop-blur-md shadow text-white flex items-center justify-center"
          aria-label="Exit room"
          title="Exit"
        >
          ⏻
        </button>
      </div>
    </div>
  );
}
