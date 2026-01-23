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


const restartVideoTrackByDeviceId = useCallback(async (deviceId: string, nextHd: boolean) => {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
  const currentStream = localStreamRef.current;
  if (!currentStream) return;

  const oldTrack = currentStream.getVideoTracks()[0];
  const base = getConstraints(isMobile, nextHd, facingMode);
  const constraints: MediaTrackConstraints = { ...base, deviceId: { exact: deviceId } };

  const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
  const newTrack = newStream.getVideoTracks()[0];

  if (newTrack) {
    if (oldTrack) {
      currentStream.removeTrack(oldTrack);
      oldTrack.stop();
    }
    currentStream.addTrack(newTrack);
    replaceOutgoingOnPeers(newTrack);
    setHdEnabled(nextHd);
    try { localStorage.setItem("anyspeak.video.hd", nextHd ? "1" : "0"); } catch {}
  }
}, [facingMode, isMobile, localStreamRef, replaceOutgoingOnPeers]);

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

  // Find the setVideoQuality function in useCamera.ts and update it to this:
const setVideoQuality = useCallback(async (mode: "sd" | "hd") => {
    const nextHd = mode === "hd";
    if (roomType !== "video" || switchingRef.current) return;
    switchingRef.current = true;
    try {
      // Logic fix: momentarily blink off to force re-render
      setCamEnabled(false);
      const ok = await applyQualityToExistingTrack(nextHd, facingMode);
      if (!ok) await restartVideoTrack(facingMode, nextHd);
      
      // Small delay ensures the browser processes the track switch
      setTimeout(() => setCamEnabled(true), 100);
      log?.("video quality changed", { hd: nextHd });
    } catch (e) {
      log?.("video quality change failed", { e: String(e) });
    } finally {
      switchingRef.current = false;
    }
  }, [applyQualityToExistingTrack, facingMode, log, restartVideoTrack, roomType, setCamEnabled]);

  const toggleCamera = useCallback(async () => {
    if (roomType !== "video") return;
    const stream = localStreamRef.current;
    const currentlyOn = !!(stream && stream.getVideoTracks().some((t) => t.enabled));
    const next = !currentlyOn;
    if (next) await acquire();
    setCamEnabled(next);
  }, [acquire, localStreamRef, roomType, setCamEnabled]);


const flipCamera = useCallback(async () => {
  try {
    // First try: toggle facingMode (works on many devices)
    const nextFacing: FacingMode = facingModeRef.current === "user" ? "environment" : "user";
    facingModeRef.current = nextFacing;

    await acquireWithOverrides({
      video: {
        facingMode: { ideal: nextFacing },
      },
    });

    // Some Android devices ignore facingMode. If we didn't actually switch cameras, fall back to deviceId cycling.
    const stream = localStreamRef.current;
    const track = stream?.getVideoTracks?.()[0];
    const settings = track?.getSettings?.() as MediaTrackSettings | undefined;
    const currentDeviceId = settings?.deviceId;

    // If we don't have a deviceId or only 1 camera, we're done.
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    if (cams.length <= 1) return;

    // If facingMode toggle didn't change the actual device, cycle deviceId.
    if (currentDeviceId) {
      const idx = cams.findIndex((c) => c.deviceId === currentDeviceId);
      const next = cams[(idx + 1 + cams.length) % cams.length];
      if (next?.deviceId && next.deviceId !== currentDeviceId) {
        await acquireWithOverrides({
          video: {
            deviceId: { exact: next.deviceId },
          },
        });
      }
    } else {
      // No deviceId available: just cycle to the second camera
      const next = cams[1];
      if (next?.deviceId) {
        await acquireWithOverrides({
          video: {
            deviceId: { exact: next.deviceId },
          },
        });
      }
    }
  } catch (err) {
    log?.("flipCamera failed", { err: String(err) });
  }
}, [acquireWithOverrides, localStreamRef, log]);

  return { toggleCamera, flipCamera, canFlip: isMobile && roomType === "video", facingMode, hdEnabled, setVideoQuality };
}
