"use client";

import { useCallback, useRef, useState } from "react";

type RoomType = "audio" | "video";
export type FacingMode = "user" | "environment";
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
  const facingModeRef = useRef<FacingMode>("user");

  const [hdEnabled, setHdEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("anyspeak.video.hd") === "1";
  });

  const switchingRef = useRef(false);

  const replaceOutgoingOnPeers = useCallback(
    (newTrack: MediaStreamTrack) => {
      peersRef?.current.forEach(({ pc }) => {
        pc.getSenders().forEach((sender) => {
          if (sender.track?.kind === "video") sender.replaceTrack(newTrack).catch(() => {});
        });
      });
    },
    [peersRef]
  );

  const restartVideoTrack = useCallback(
    async (nextFacing: FacingMode, nextHd: boolean) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
      const currentStream = localStreamRef.current;
      if (!currentStream) return;

      const oldTrack = currentStream.getVideoTracks()[0];
      const constraints = getConstraints(isMobile, nextHd, nextFacing);
      const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0];

      if (newTrack) {
        if (oldTrack) {
          currentStream.removeTrack(oldTrack);
          try {
            oldTrack.stop();
          } catch {}
        }
        currentStream.addTrack(newTrack);
        replaceOutgoingOnPeers(newTrack);
      }
    },
    [isMobile, localStreamRef, replaceOutgoingOnPeers]
  );

  const restartVideoTrackByDeviceId = useCallback(
    async (deviceId: string, nextHd: boolean) => {
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) return;
      const currentStream = localStreamRef.current;
      if (!currentStream) return;

      const oldTrack = currentStream.getVideoTracks()[0];
      // When selecting a specific deviceId, omit facingMode. Some Android browsers will ignore or conflict.
      const baseNoFacing: MediaTrackConstraints = isMobile
        ? { width: { ideal: nextHd ? 1280 : 960 }, height: { ideal: nextHd ? 720 : 540 } }
        : { width: { ideal: nextHd ? 1920 : 1280 }, height: { ideal: nextHd ? 1080 : 720 } };
      const constraints: MediaTrackConstraints = { ...baseNoFacing, deviceId: { exact: deviceId } };

      const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0];

      if (newTrack) {
        if (oldTrack) {
          currentStream.removeTrack(oldTrack);
          try {
            oldTrack.stop();
          } catch {}
        }
        currentStream.addTrack(newTrack);
        replaceOutgoingOnPeers(newTrack);
      }
    },
    [isMobile, localStreamRef, replaceOutgoingOnPeers]
  );

  const applyQualityToExistingTrack = useCallback(
    async (nextHd: boolean, facing: FacingMode) => {
      const track = localStreamRef.current?.getVideoTracks()[0];
      if (!track || typeof track.applyConstraints !== "function") return false;
      try {
        await track.applyConstraints(getConstraints(isMobile, nextHd, facing));
        return true;
      } catch {
        return false;
      }
    },
    [isMobile, localStreamRef]
  );

  const setVideoQuality = useCallback(
    async (mode: "sd" | "hd") => {
      const nextHd = mode === "hd";
      if (roomType !== "video" || switchingRef.current) return;
      switchingRef.current = true;
      try {
        // Force a brief UI update so the page re-renders correctly.
        setCamEnabled(false);
        const ok = await applyQualityToExistingTrack(nextHd, facingModeRef.current);
        if (!ok) await restartVideoTrack(facingModeRef.current, nextHd);

        setHdEnabled(nextHd);
        try {
          localStorage.setItem("anyspeak.video.hd", nextHd ? "1" : "0");
        } catch {}

        setTimeout(() => setCamEnabled(true), 80);
        log?.("video quality changed", { hd: nextHd });
      } catch (e) {
        log?.("video quality change failed", { e: String(e) });
      } finally {
        switchingRef.current = false;
      }
    },
    [applyQualityToExistingTrack, log, restartVideoTrack, roomType, setCamEnabled]
  );

  const toggleCamera = useCallback(
    async () => {
      if (roomType !== "video") return;
      const stream = localStreamRef.current;
      const currentlyOn = !!(stream && stream.getVideoTracks().some((t) => t.enabled));
      const next = !currentlyOn;
      if (next) await acquire();
      setCamEnabled(next);
    },
    [acquire, localStreamRef, roomType, setCamEnabled]
  );

  const flipCamera = useCallback(
    async () => {
      if (!isMobile || roomType !== "video" || switchingRef.current) return;
      switchingRef.current = true;
      try {
        const stream = localStreamRef.current;
        const beforeTrack = stream?.getVideoTracks?.()[0];
        const beforeDeviceId = (beforeTrack?.getSettings?.() as MediaTrackSettings | undefined)?.deviceId;

        const nextFacing: FacingMode = facingModeRef.current === "user" ? "environment" : "user";
        facingModeRef.current = nextFacing;
        setFacingMode(nextFacing);

        // Try facingMode-based restart first.
        await restartVideoTrack(nextFacing, hdEnabled);

        // If Android ignored facingMode and we still have the same camera, cycle by deviceId.
        const afterTrack = localStreamRef.current?.getVideoTracks?.()[0];
        const afterDeviceId = (afterTrack?.getSettings?.() as MediaTrackSettings | undefined)?.deviceId;

        if (beforeDeviceId && afterDeviceId && beforeDeviceId === afterDeviceId) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const cams = devices.filter((d) => d.kind === "videoinput");
          if (cams.length > 1) {
            const idx = cams.findIndex((c) => c.deviceId === afterDeviceId);
            const next = cams[(idx + 1 + cams.length) % cams.length];
            if (next?.deviceId && next.deviceId !== afterDeviceId) {
              await restartVideoTrackByDeviceId(next.deviceId, hdEnabled);
            }
          }
        }

        log?.("flipCamera", { facing: nextFacing });
      } catch (err) {
        log?.("flipCamera failed", { err: String(err) });
      } finally {
        switchingRef.current = false;
      }
    },
    [hdEnabled, isMobile, localStreamRef, log, restartVideoTrack, restartVideoTrackByDeviceId, roomType]
  );

  return {
    toggleCamera,
    flipCamera,
    canFlip: isMobile && roomType === "video",
    facingMode,
    hdEnabled,
    setVideoQuality,
  };
}
