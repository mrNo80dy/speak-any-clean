"use client";

import React from "react";

type Props = {
  visible: boolean;
  ccOn: boolean;
  sdOn: boolean;
  onToggleCc: () => void;
  onToggleSd: () => void;
  onExit?: () => void;
};

export function TopHud({
  visible,
  ccOn,
  sdOn,
  onToggleCc,
  onToggleSd,
  onExit,
}: Props) {
  return (
    <header
      className={`absolute top-2 left-2 right-2 z-20 flex justify-center pointer-events-none transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div className="flex items-center gap-4 pointer-events-auto">
        <IconButton
          label="Captions"
          active={ccOn}
          onClick={onToggleCc}
        >
          CC
        </IconButton>

        <IconButton
          label="Standard / HD"
          active={sdOn}
          onClick={onToggleSd}
        >
          HD
        </IconButton>

        {onExit && (
          <IconButton label="Exit" onClick={onExit}>
            ⤫
          </IconButton>
        )}
      </div>
    </header>
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
      className={`w-12 h-12 flex items-center justify-center text-white text-lg select-none transition-opacity ${
        active ? "opacity-100" : "opacity-70 hover:opacity-100"
      } bg-transparent border-0 rounded-none shadow-none appearance-none`}
    >
      {children}
    </button>
  );
}
