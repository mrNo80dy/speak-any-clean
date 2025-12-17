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
    if (localStreamRef.current) return localStreamRef.current;

    const constraints: MediaStreamConstraints = {
      audio: wantAudio,
      video: opts.wantVideo
        ? { width: { ideal: 1280 }, height: { ideal: 720 } }
        : false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;

    // Default all tracks OFF until caller enables them per UX rules.
    const a = stream.getAudioTracks?.()[0] || null;
    if (a) a.enabled = false;

    const v = stream.getVideoTracks?.()[0] || null;
    if (v) v.enabled = false;

    // If we didn't request audio, reflect that in state
    setMicOn(false);
    setCamOn(false);

    // Attach if the video element already exists
    if (localVideoElRef.current) attachLocalVideo(localVideoElRef.current);

    return stream;
  }, [attachLocalVideo, opts.wantVideo, wantAudio]);

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
