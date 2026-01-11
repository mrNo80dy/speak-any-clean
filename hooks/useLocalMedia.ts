"use client";

import { useCallback, useRef, useState } from "react";

type UseLocalMediaOpts = {
  wantVideo: boolean; // video call => true, audio call => false
  wantAudio?: boolean; // default true; set false for STT-only/mobile no-raw-mic
};

export function useLocalMedia(opts: UseLocalMediaOpts) {
  const wantAudio = opts.wantAudio ?? true;

  const localStreamRef = useRef<MediaStream | null>(null);
  const localVideoElRef = useRef<HTMLVideoElement | null>(null);

  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);

  const attachLocalVideo = useCallback((el: HTMLVideoElement | null) => {
    localVideoElRef.current = el;
    const stream = localStreamRef.current;
    if (!el || !stream) return;

    if (el.srcObject !== stream) el.srcObject = stream;
    el.muted = true;
    el.playsInline = true as any;
    el.setAttribute("playsinline", "true");
    el.play().catch(() => {});
  }, []);

  const acquire = useCallback(async () => {
    if (typeof navigator === "undefined") return null;

    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);

    // Favor smaller, more reliable capture settings to reduce bandwidth/relay usage.
    // Mobile: prefer portrait-ish capture.
    const videoConstraints: MediaTrackConstraints | false = opts.wantVideo
      ? isMobile
        ? {
            width: { ideal: 1280 },
            frameRate: { ideal: 24, max: 30 },
            facingMode: "user",
          }
        : {
            width: { ideal: 960 },
            height: { ideal: 540 },
            frameRate: { ideal: 24, max: 30 },
          }
      : false;

    const baseConstraints: MediaStreamConstraints = {
      audio: wantAudio,
      video: videoConstraints,
    };

    // If we already have a stream, allow "upgrading" it (e.g. audio-only -> add video track)
    const existing = localStreamRef.current;
    if (existing) {
      const hasAudio = existing.getAudioTracks().length > 0;
      const hasVideo = existing.getVideoTracks().length > 0;

      // Upgrade: add missing audio track
      if (wantAudio && !hasAudio) {
        try {
          const a = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          const at = a.getAudioTracks()[0];
          if (at) existing.addTrack(at);
        } catch {}
      }

      // Upgrade: add missing video track
      if (opts.wantVideo && !hasVideo) {
        try {
          const v = await navigator.mediaDevices.getUserMedia({ audio: false, video: videoConstraints || true });
          const vt = v.getVideoTracks()[0];
          if (vt) existing.addTrack(vt);
        } catch {}
      }

      // Re-attach to any bound element
      attachLocalVideo(localVideoElRef.current);
      return existing;
    }

    // Fresh acquire
    const stream = await navigator.mediaDevices.getUserMedia(baseConstraints);

    localStreamRef.current = stream;

    // Bind local preview if present
    attachLocalVideo(localVideoElRef.current);

    return stream;
  },}, [attachLocalVideo, opts.wantVideo, wantAudio]);

  const setMicEnabled = useCallback((enabled: boolean) => {
    const s = localStreamRef.current;
    const a = s?.getAudioTracks?.()[0] || null;

    // If no audio track exists (wantAudio=false), just keep UI state coherent
    if (a) a.enabled = enabled;
  // ✅ Always reflect the user's intent in the UI (mobile STT-only has no audio track)
    setMicOn(enabled);
  }, []);

  const setCamEnabled = useCallback((enabled: boolean) => {
    const s = localStreamRef.current;
    const v = s?.getVideoTracks?.()[0] || null;
    if (v) v.enabled = enabled;
    setCamOn(Boolean(v) && enabled);
  }, []);

  const stop = useCallback(() => {
    const s = localStreamRef.current;
    if (!s) return;

    try {
      s.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {}
      });
    } catch {}

    localStreamRef.current = null;

    // Clear element binding so camera light/etc. releases cleanly
    const el = localVideoElRef.current;
    if (el) {
      try {
        // @ts-ignore
        el.srcObject = null;
      } catch {}
    }

    setMicOn(false);
    setCamOn(false);
  }, []);

  return {
    localStreamRef,
    micOn,
    camOn,
    acquire,
    attachLocalVideo,
    setMicEnabled,
    setCamEnabled,
    stop,
    wantAudio,
  };
}
