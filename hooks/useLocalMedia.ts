"use client";

import { useCallback, useRef, useState } from "react";

type UseLocalMediaOpts = {
  wantVideo: boolean; // audio call => false, video call => true
};

export function useLocalMedia(opts: UseLocalMediaOpts) {
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
    if (localStreamRef.current) return localStreamRef.current;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: opts.wantVideo ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
    });

    localStreamRef.current = stream;

    // default all tracks off until caller enables based on UX rules
    const a = stream.getAudioTracks()[0];
    if (a) a.enabled = false;

    const v = stream.getVideoTracks()[0];
    if (v) v.enabled = false;

    // attach if the video element already exists
    if (localVideoElRef.current) attachLocalVideo(localVideoElRef.current);

    setMicOn(false);
    setCamOn(false);

    return stream;
  }, [attachLocalVideo, opts.wantVideo]);

  const setMicEnabled = useCallback((enabled: boolean) => {
    const s = localStreamRef.current;
    if (!s) return;
    const a = s.getAudioTracks()[0];
    if (a) a.enabled = enabled;
    setMicOn(enabled);
  }, []);

  const setCamEnabled = useCallback((enabled: boolean) => {
    const s = localStreamRef.current;
    if (!s) return;
    const v = s.getVideoTracks()[0];
    if (v) v.enabled = enabled;
    setCamOn(enabled);
  }, []);

  return {
    localStreamRef,
    micOn,
    camOn,
    acquire,
    attachLocalVideo,
    setMicEnabled,
    setCamEnabled,
  };
}
