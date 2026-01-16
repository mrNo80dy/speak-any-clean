"use client";

import { useCallback, useRef, useState } from "react";

type RoomType = "audio" | "video";
type FacingMode = "user" | "environment";
type AnySpeakPeer = { pc: RTCPeerConnection };

type Args = {
  isMobile: boolean;
  roomType: RoomType | null;
  acquire: () => Promise<MediaStream | null>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  setCamEnabled: (enabled: boolean) => void;
  peersRef?: React.MutableRefObject<Map<string, AnySpeakPeer>>;
  log?: (msg: string, data?: any) => void;
};

function getConstraints(isMobile: boolean, hd: boolean, facing: FacingMode): MediaTrackConstraints {
  if (isMobile) {
    return {
      facingMode: { ideal: facing },
      width: { ideal: hd ? 1280 : 960 },
      height: { ideal: hd ? 720 : 540 },
    };
  }
  return {
    width: { ideal: hd ? 1920 : 1280 },
    height: { ideal: hd ? 1080 : 720 },
  };
}

export function useCamera({ isMobile, roomType, acquire, localStreamRef, setCamEnabled, peersRef, log }: Args) {
  const [facingMode, setFacingMode] = useState<FacingMode>("user");
  const [hdEnabled, setHdEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("anyspeak.video.hd") === "1";
  });

  const switchingRef = useRef(false);

  const replaceOutgoingOnPeers = useCallback((newTrack: MediaStreamTrack) => {
    peersRef?.current.forEach(({ pc }) => {
      pc.getSenders().forEach((sender) => {
        if (sender.track?.kind === "video") sender.replaceTrack(newTrack).catch(() => {});
      });
    });
  }, [peersRef]);

  const restartVideoTrack = useCallback(async (nextFacing: FacingMode, nextHd: boolean) => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
    const currentStream = localStreamRef.current;
    if (!currentStream) return;

    const oldTrack = currentStream.getVideoTracks()[0];
    const constraints = getConstraints(isMobile, nextHd, nextFacing);
    const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    const newTrack = newStream.getVideoTracks()[0];

    if (newTrack) {
      if (oldTrack) { currentStream.removeTrack(oldTrack); oldTrack.stop(); }
      currentStream.addTrack(newTrack);
      replaceOutgoingOnPeers(newTrack);
      setHdEnabled(nextHd);
      localStorage.setItem("anyspeak.video.hd", nextHd ? "1" : "0");
    }
  }, [isMobile, localStreamRef, replaceOutgoingOnPeers]);

  const applyQualityToExistingTrack = useCallback(async (nextHd: boolean, facing: FacingMode) => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.applyConstraints !== "function") return false;
    try {
      await track.applyConstraints(getConstraints(isMobile, nextHd, facing));
      setHdEnabled(nextHd);
      localStorage.setItem("anyspeak.video.hd", nextHd ? "1" : "0");
      return true;
    } catch { return false; }
  }, [isMobile, localStreamRef]);

  const setVideoQuality = useCallback(async (mode: "sd" | "hd") => {
    const nextHd = mode === "hd";
    if (roomType !== "video" || switchingRef.current) return;
    switchingRef.current = true;
    try {
      setCamEnabled(false); // Blink off
      const ok = await applyQualityToExistingTrack(nextHd, facingMode);
      if (!ok) await restartVideoTrack(facingMode, nextHd);
      setTimeout(() => setCamEnabled(true), 100); // Blink back on
    } finally {
      switchingRef.current = false;
    }
  }, [applyQualityToExistingTrack, facingMode, restartVideoTrack, roomType, setCamEnabled]);

  const toggleCamera = useCallback(async () => {
    if (roomType !== "video") return;
    const stream = localStreamRef.current;
    const currentlyOn = !!(stream && stream.getVideoTracks().some((t) => t.enabled));
    const next = !currentlyOn;
    if (next) await acquire();
    setCamEnabled(next);
  }, [acquire, localStreamRef, roomType, setCamEnabled]);

  const flipCamera = useCallback(async () => {
    if (!isMobile || roomType !== "video" || switchingRef.current) return;
    switchingRef.current = true;
    const nextFacing: FacingMode = facingMode === "user" ? "environment" : "user";
    try {
      await restartVideoTrack(nextFacing, hdEnabled);
      setFacingMode(nextFacing);
    } finally {
      switchingRef.current = false;
    }
  }, [facingMode, hdEnabled, isMobile, restartVideoTrack, roomType]);

  return { toggleCamera, flipCamera, canFlip: isMobile && roomType === "video", facingMode, hdEnabled, setVideoQuality };
}
