"use client";

import React from "react";

type Props = {
  visible: boolean;
  isMobile: boolean;
  camOn: boolean;
  micOn: boolean;
  showTextInput: boolean;
  onToggleCamera: () => void;
  onToggleMic: () => void;
  onToggleText: () => void;
};

export function BottomRightHud({
  visible,
  isMobile,
  camOn,
  micOn,
  showTextInput,
  onToggleCamera,
  onToggleMic,
  onToggleText,
}: Props) {
  return (
    <div
      className={`fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-30 flex flex-col items-center gap-3 transition-opacity duration-300 ${
        visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
      }`}
    >
      {/* Mic toggle (PC only) */}
      {!isMobile && (
        <IconButton
          label={micOn ? "Mute mic" : "Unmute mic"}
          onClick={onToggleMic}
          active={micOn}
        >
          🎙️
        </IconButton>
      )}

      {/* Camera toggle */}
      <IconButton
        label={camOn ? "Turn camera off" : "Turn camera on"}
        onClick={onToggleCamera}
        active={camOn}
      >
        📷
      </IconButton>

      {/* Text toggle */}
      <IconButton
        label={showTextInput ? "Close text input" : "Send text"}
        onClick={onToggleText}
        active={showTextInput}
      >
        💬
      </IconButton>
    </div>
  );
}

function IconButton({
  children,
  onClick,
  label,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`w-14 h-14 flex items-center justify-center text-white text-2xl select-none transition-opacity ${
  active ? "opacity-100" : "opacity-70 hover:opacity-100"
} bg-black/0 border-0 rounded-2xl shadow-none appearance-none`}
    >
      {children}
    </button>
  );
}
