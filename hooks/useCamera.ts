"use client";

import { useCallback, useRef, useState } from "react";

type RoomType = "audio" | "video";
type FacingMode = "user" | "environment";

// Minimal peer shape we need for replacing tracks
type AnySpeakPeer = { pc: RTCPeerConnection };

type Args = {
  isMobile: boolean;
  roomType: RoomType | null;
  joinCamOn: boolean | null;

  // acquire should ensure localStreamRef.current is populated (and local preview attached by caller)
  acquire: () => Promise<MediaStream | null>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  setCamEnabled: (enabled: boolean) => void;

  // Optional: replace outgoing video on all peer connections
  peersRef?: React.MutableRefObject<Map<string, AnySpeakPeer>>;
  log?: (msg: string, data?: any) => void;
};

function getConstraints(isMobile: boolean, hd: boolean, facing: FacingMode): MediaTrackConstraints {
  // Conservative defaults to reduce heat on phones
  if (isMobile) {
    if (hd) {
      return {
        facingMode: { ideal: facing },
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 24, max: 30 },
      };
    }
    return {
      facingMode: { ideal: facing },
      width: { ideal: 960, max: 1280 },
      height: { ideal: 540, max: 720 },
      frameRate: { ideal: 20, max: 24 },
    };
  }

  // Desktop
  if (hd) {
    return {
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 30, max: 30 },
    };
  }
  return {
    width: { ideal: 1280, max: 1280 },
    height: { ideal: 720, max: 720 },
    frameRate: { ideal: 24, max: 30 },
  };
}

export function useCamera({
  isMobile,
  roomType,
  joinCamOn,
  acquire,
  localStreamRef,
  setCamEnabled,
  peersRef,
  log,
}: Args) {
  const [facingMode, setFacingMode] = useState<FacingMode>("user");
  const [hdEnabled, setHdEnabled] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("anyspeak.video.hd") === "1";
  });

  const switchingRef = useRef(false);

  const replaceOutgoingOnPeers = useCallback(
    (newTrack: MediaStreamTrack) => {
      const map = peersRef?.current;
      if (!map) return;

      map.forEach(({ pc }) => {
        try {
          pc.getSenders().forEach((sender: RTCRtpSender) => {
            if (sender.track && sender.track.kind === "video") {
              sender.replaceTrack(newTrack).catch(() => {});
            }
          });
        } catch {}
      });
    },
    [peersRef]
  );

  const persistHd = useCallback((nextHd: boolean) => {
    setHdEnabled(nextHd);
    try {
      window.localStorage.setItem("anyspeak.video.hd", nextHd ? "1" : "0");
    } catch {}
  }, []);

  const beforeConnect = useCallback(async () => {
    if (roomType !== "video") {
      setCamEnabled(false);
      return;
    }

    if (joinCamOn) {
      try {
        await acquire();
        setCamEnabled(true);
      } catch {
        setCamEnabled(false);
      }
    } else {
      setCamEnabled(false);
    }
  }, [acquire, joinCamOn, roomType, setCamEnabled]);

  const toggleCamera = useCallback(async () => {
    if (roomType !== "video") return;

    const stream = localStreamRef.current;
    const currentlyOn = !!(stream && stream.getVideoTracks().some((t) => t.enabled));
    const next = !currentlyOn;

    if (next) {
      try {
        await acquire();
      } catch {}
      // default back to selfie when turning on
      setFacingMode("user");
    }

    setCamEnabled(next);
  }, [acquire, localStreamRef, roomType, setCamEnabled]);

  const restartVideoTrack = useCallback(
    async (nextFacing: FacingMode, nextHd: boolean) => {
      const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!md?.getUserMedia) return;

      const currentStream = localStreamRef.current;
      if (!currentStream) return;

      const oldTrack = currentStream.getVideoTracks?.()[0] ?? null;

      const constraints = getConstraints(isMobile, nextHd, nextFacing);
      const newStream = await md.getUserMedia({ video: constraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0] || null;
      if (!newTrack) return;

      if (oldTrack) {
        try {
          currentStream.removeTrack(oldTrack);
        } catch {}
        try {
          oldTrack.stop();
        } catch {}
      }
      try {
        currentStream.addTrack(newTrack);
      } catch {}

      replaceOutgoingOnPeers(newTrack);
      persistHd(nextHd);
    },
    [isMobile, localStreamRef, persistHd, replaceOutgoingOnPeers]
  );

  const applyQualityToExistingTrack = useCallback(
    async (nextHd: boolean, facing: FacingMode) => {
      const currentStream = localStreamRef.current;
      const track = currentStream?.getVideoTracks?.()[0];
      if (!track) return false;

      // Not all browsers support applyConstraints reliably, but try it first.
      if (typeof track.applyConstraints !== "function") return false;

      try {
        const constraints = getConstraints(isMobile, nextHd, facing);
        await track.applyConstraints(constraints);
        replaceOutgoingOnPeers(track);
        persistHd(nextHd);
        return true;
      } catch {
        return false;
      }
    },
    [isMobile, localStreamRef, persistHd, replaceOutgoingOnPeers]
  );

  const setVideoQuality = useCallback(
    async (nextHd: boolean) => {
      if (roomType !== "video") return;
      if (switchingRef.current) return;
      switchingRef.current = true;

      try {
        const ok = await applyQualityToExistingTrack(nextHd, facingMode);
        if (!ok) {
          await restartVideoTrack(facingMode, nextHd);
        }
        log?.("video quality changed", { hd: nextHd });
      } catch (e) {
        log?.("video quality change failed", { e: String(e) });
      } finally {
        switchingRef.current = false;
      }
    },
    [applyQualityToExistingTrack, facingMode, log, restartVideoTrack, roomType]
  );

  const flipCamera = useCallback(async () => {
    if (!isMobile) return;
    if (roomType !== "video") return;
    if (switchingRef.current) return;

    switchingRef.current = true;
    const nextFacing: FacingMode = facingMode === "user" ? "environment" : "user";

    try {
      // Prefer restarting track for facing-mode changes (most reliable)
      await restartVideoTrack(nextFacing, hdEnabled);
      setFacingMode(nextFacing);
      log?.("camera flip", { nextFacing });
    } catch (e) {
      log?.("camera flip failed", { e: String(e) });
    } finally {
      switchingRef.current = false;
    }
  }, [facingMode, hdEnabled, isMobile, log, restartVideoTrack, roomType]);

  const canFlip = isMobile && roomType === "video";

  return {
    beforeConnect,
    toggleCamera,
    flipCamera,
    canFlip,
    facingMode,
    hdEnabled,
    setVideoQuality,
  };
}
