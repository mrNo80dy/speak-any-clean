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

export function BottomRightHud({ visible, isMobile, camOn, micOn, showTextInput, onToggleCamera, onToggleMic, onToggleText }: Props) {
  return (
    <div className={`fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-30 flex flex-col items-center gap-3 transition-opacity duration-300 ${visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}>
      
      {/* Mic toggle: Distinct icons for Active vs Muted */}
      {!isMobile && (
        <IconButton label={micOn ? "Mute" : "Unmute"} onClick={onToggleMic} active={micOn}>
          {micOn ? "🎙️" : "🔕"}
        </IconButton>
      )}

      {/* Camera toggle: Distinct icons for Video vs Still */}
      <IconButton label={camOn ? "Camera Off" : "Camera On"} onClick={onToggleCamera} active={camOn}>
        {camOn ? "📹" : "📷"}
      </IconButton>

      <IconButton label={showTextInput ? "Hide Chat" : "Open Chat"} onClick={onToggleText} active={showTextInput}>
        💬
      </IconButton>
    </div>
  );
}

function IconButton({ children, onClick, label, active }: { children: React.ReactNode; onClick: () => void; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`w-14 h-14 flex items-center justify-center text-2xl transition-all rounded-2xl border ${
        active 
          ? "bg-emerald-500/20 border-emerald-500/30 shadow-lg scale-105" 
          : "bg-black/40 border-white/10 opacity-70 hover:opacity-100"
      }`}
    >
      {children}
    </button>
  );
}
