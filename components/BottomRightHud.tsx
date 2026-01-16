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
  onToggleText 
}: Props) {
  return (
    <div className={`fixed right-3 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-30 flex flex-col items-center gap-3 transition-opacity duration-300 ${visible ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"}`}>
      
      {/* Microphone Toggle - Stays 🎙️ with a red line when off */}
      {!isMobile && (
        <IconButton 
          label={micOn ? "Mute" : "Unmute"} 
          onClick={onToggleMic} 
          active={micOn}
          crossedOut={!micOn}
        >
          🎙️
        </IconButton>
      )}

      {/* Camera Toggle - Stays 📹 with a red line when off */}
      <IconButton 
        label={camOn ? "Camera Off" : "Camera On"} 
        onClick={onToggleCamera} 
        active={camOn}
        crossedOut={!camOn}
      >
        📹
      </IconButton>

      {/* Chat Toggle */}
      <IconButton 
        label={showTextInput ? "Hide Chat" : "Open Chat"} 
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
  crossedOut 
}: { 
  children: React.ReactNode; 
  onClick: () => void; 
  label: string; 
  active?: boolean;
  crossedOut?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`w-14 h-14 flex items-center justify-center text-2xl relative transition-all rounded-2xl border ${
        active 
          ? "bg-emerald-500/20 border-emerald-500/30 shadow-lg scale-105" 
          : "bg-black/40 border-white/10 opacity-70 hover:opacity-100"
      }`}
    >
      <span className={crossedOut ? "opacity-40" : ""}>{children}</span>
      
      {/* The Consistent Red Line Overlay */}
      {crossedOut && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="w-[70%] h-[3px] bg-red-500 rotate-45 rounded-full shadow-[0_0_2px_rgba(0,0,0,0.5)]" />
        </div>
      )}
    </button>
  );
}
