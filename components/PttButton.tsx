"use client";

import React from "react";

type Props = {
  isPressed: boolean;
  disabled?: boolean;
  onPressStart: () => void;
  onPressEnd: () => void;
};

export function PttButton({
  isPressed,
  disabled,
  onPressStart,
  onPressEnd,
}: Props) {
  return (
    <div
      className="fixed left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+12px)] z-40 pointer-events-auto"
    >
      <button
        type="button"
        disabled={disabled}
        aria-label="Push to talk"
        onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (!disabled) onPressStart();
        }}
        onPointerUp={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onPressEnd();
        }}
        onPointerLeave={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onPressEnd();
        }}
        className={`w-20 h-20 rounded-full border-2 transition-transform select-none ${
          isPressed
            ? "scale-95 border-emerald-400"
            : "border-white/60"
        } bg-transparent shadow-none appearance-none`}
      >
        {/* Ring only — no center icon */}
      </button>
    </div>
  );
}
