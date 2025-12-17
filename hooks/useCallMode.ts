"use client";

import { useMemo } from "react";

export type CallMode = "audio" | "video";

export function useCallMode(opts: {
  modeParam: string | null;          // from URL ?mode=
  participantCount: number;          // includes local
}) {
  const mode: CallMode = useMemo(() => {
    return opts.modeParam === "video" ? "video" : "audio";
  }, [opts.modeParam]);

  // Your rules:
  // - camera off for audio calls, on for video calls
  // - 2 users: mic on by default
  // - 3+ users: mic off by default
  const defaults = useMemo(() => {
    const micDefaultOn = opts.participantCount <= 2;
    const camDefaultOn = mode === "video";
    return { micDefaultOn, camDefaultOn };
  }, [mode, opts.participantCount]);

  return { mode, ...defaults };
}
