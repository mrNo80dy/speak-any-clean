"use client";

import React from "react";

// ... Props type

export function TopHud({ visible, ccOn, hdOn, onToggleCc, onToggleHd, onShare, onExit }: Props) {
  return (
    <header className={`absolute top-2 left-2 right-2 z-20 flex justify-center pointer-events-none transition-opacity duration-300 ${visible ? "opacity-100" : "opacity-0"}`}>
      <div className="flex items-center gap-3 pointer-events-auto bg-black/40 backdrop-blur-xl px-2 py-1 rounded-2xl border border-white/10">
        
        {/* CC Toggle: Filled vs Outlined appearance */}
        <IconButton label="Captions" active={ccOn} onClick={onToggleCc}>
          <span className={ccOn ? "text-emerald-400" : "opacity-40"}>CC</span>
        </IconButton>

        {onShare && <IconButton label="Share" onClick={onShare}>↗</IconButton>}

        {/* HD Toggle: Explicitly clickable state even when active */}
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

// IconButton helper remains similar but ensures hover states for HD even when green
