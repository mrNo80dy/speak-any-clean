"use client";

import React from "react";

type Props = {
  visible: boolean;
  ccOn: boolean;
  hdOn: boolean;
  onToggleCc: () => void;
  onToggleHd: () => void;
  onShare?: () => void;
  onExit?: () => void;
};

export function TopHud({ visible, ccOn, hdOn, onToggleCc, onToggleHd, onShare, onExit }: Props) {
  return (
    <header className={`absolute top-2 left-2 right-2 z-20 flex justify-center pointer-events-none transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}>
      <div className="flex items-center gap-3 pointer-events-auto bg-black/40 backdrop-blur-xl px-2 py-1 rounded-2xl border border-white/10">
        
        {/* CC Toggle */}
        <IconButton label="Captions" active={ccOn} onClick={onToggleCc}>
          <span className={ccOn ? "text-emerald-400" : "opacity-40"}>CC</span>
        </IconButton>

        {onShare && <IconButton label="Share" onClick={onShare}>↗</IconButton>}

        {/* HD Toggle */}
        <IconButton 
          label={hdOn ? "Switch to SD" : "Switch to HD"} 
          active={hdOn} 
          onClick={onToggleHd}
        >
          <div className="flex flex-col items-center leading-none">
            <span className={hdOn ? "text-emerald-400 font-black" : "text-white opacity-40 font-bold"}>
              {hdOn ? "HD" : "SD"}
            </span>
            <div className={`h-1 w-4 mt-0.5 rounded-full transition-colors ${hdOn ? "bg-emerald-500" : "bg-transparent"}`} />
          </div>
        </IconButton>

        {onExit && <IconButton label="Exit" onClick={onExit}>✕</IconButton>}
      </div>
    </header>
  );
}

function IconButton({ children, onClick, label, active }: { children: React.ReactNode; onClick: () => void; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`w-11 h-11 flex items-center justify-center text-white text-[13px] font-bold select-none transition-all rounded-xl ${
        active ? "bg-white/10 shadow-inner" : "hover:bg-white/5"
      }`}
    >
      {children}
    </button>
  );
}
