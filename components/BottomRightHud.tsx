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
      
      {/* Mic toggle: Uses a filled mic for ON and an empty/muted symbol for OFF */}
      {!isMobile && (
        <IconButton 
          label={micOn ? "Mute" : "Unmute"} 
          onClick={onToggleMic} 
          active={micOn}
        >
          {micOn ? (
            <span className="text-emerald-400">🎙️</span> // Active State
          ) : (
            <span className="opacity-50">🔇</span> // Muted State (Distinct Icon)
          )}
        </IconButton>
      )}

      {/* Camera toggle: Video Camera vs Still Camera icons */}
      <IconButton 
        label={camOn ? "Camera Off" : "Camera On"} 
        onClick={onToggleCamera} 
        active={camOn}
      >
        {camOn ? (
          <span className="text-emerald-400">📹</span> // Active Video
        ) : (
          <span className="opacity-50">📷</span> // Inactive Still
        )}
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
          ? "bg-emerald-500/10 border-emerald-500/30 shadow-lg scale-105" 
          : "bg-black/40 border-white/10 opacity-70"
      }`}
    >
      {children}
    </button>
  );
}
