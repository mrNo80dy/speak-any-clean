"use client";

import { useCallback, useRef, useState } from "react";

type RoomType = "audio" | "video";

type AnySpeakPeer = { pc: RTCPeerConnection };

type Args = {
  isMobile: boolean;
  roomType: RoomType | null;
  joinCamOn: boolean | null;

  // acquire should return the (possibly updated) local stream
  acquire: () => Promise<MediaStream | null>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  setCamEnabled: (enabled: boolean) => void;

  // Optional: if provided, we replace the outgoing track on all peer connections.
  peersRef?: React.MutableRefObject<Map<string, AnySpeakPeer>>;
  log?: (msg: string, data?: any) => void;
};

type FacingMode = "user" | "environment";

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
      // default to selfie cam when turning back on
      setFacingMode("user");
    }

    setCamEnabled(next);
  }, [acquire, localStreamRef, roomType, setCamEnabled]);

  const flipCamera = useCallback(async () => {
    // Only makes sense on mobile + in video rooms
    if (!isMobile) return;
    if (roomType !== "video") return;
    if (switchingRef.current) return;

    const currentStream = localStreamRef.current;
    const oldTrack = currentStream?.getVideoTracks?.()[0] ?? null;
    if (!currentStream || !oldTrack) return;

    // Some browsers allow applyConstraints; others require a new getUserMedia.
    const nextFacing: FacingMode = facingMode === "user" ? "environment" : "user";
    switchingRef.current = true;

    try {
      // Reliable path: always acquire a new track.
      // (applyConstraints works on some devices, but is inconsistent and often breaks sizing)
      const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
      if (!md?.getUserMedia) return;

      const newStream = await md.getUserMedia({
        video: {
          facingMode: { ideal: nextFacing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      const newTrack = newStream.getVideoTracks()[0];
      if (!newTrack) return;

      // Replace in local stream (keep the same MediaStream instance so all refs stay valid)
      try {
        currentStream.removeTrack(oldTrack);
      } catch {}
      try {
        oldTrack.stop();
      } catch {}
      try {
        currentStream.addTrack(newTrack);
      } catch {}

      // Replace on all peer connections (so the other side updates without re-offer)
      if (peersRef?.current) {
        peersRef.current.forEach(({ pc }) => {
          try {
            const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
            if (sender) sender.replaceTrack(newTrack);
          } catch {}
        });
      }

      // Ensure the local preview refreshes immediately.
      
      setFacingMode(nextFacing);
      log?.("camera flip (new track)", { nextFacing });
    } finally {
      switchingRef.current = false;
    }
  }, [facingMode, isMobile, localStreamRef, peersRef, roomType, log]);

  

const getQualityConstraints = useCallback(
  (hd: boolean, facing: FacingMode): MediaTrackConstraints => {
    // Keep this conservative to reduce heat on phones.
    if (isMobile) {
      if (hd) {
        return {
          width: { ideal: 1280, max: 1920 },
          height: { ideal: 720, max: 1080 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: facing,
        };
      }
      return {
        width: { ideal: 960, max: 1280 },
        height: { ideal: 540, max: 720 },
        frameRate: { ideal: 20, max: 24 },
        facingMode: facing,
      };
    }

    // Desktop defaults
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
  },
  [isMobile]
);

const setVideoQuality = useCallback(
  async (nextHd: boolean) => {
    if (roomType !== "video") return;
    const currentStream = localStreamRef.current;
    if (!currentStream) return;

    const constraints = getQualityConstraints(nextHd, facingMode);

    try {
      const md = navigator.mediaDevices;
      const newStream = await md.getUserMedia({ video: constraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0] || null;
      if (!newTrack) return;

      const oldTrack = currentStream.getVideoTracks?.()?.[0] ?? null;
      if (oldTrack) {
        try {
          currentStream.removeTrack(oldTrack);
          oldTrack.stop();
        } catch {}
      }
      currentStream.addTrack(newTrack);

      // Replace on all peer connections
      Object.values(peersRef?.current || {}).forEach((peer) => {
        try {
          peer?.pc?.getSenders().forEach((sender: RTCRtpSender) => {
  if (sender.track && sender.track.kind === "video") {
    sender.replaceTrack(newTrack).catch(() => {});
  }
});

        } catch {}
      });

      setHdEnabled(nextHd);
      try {
        window.localStorage.setItem("anyspeak.video.hd", nextHd ? "1" : "0");
      } catch {}
      log?.("video quality changed", { hd: nextHd });
    } catch (e) {
      log?.("video quality change failed", { e: String(e) });
    }
  },
  [facingMode, getQualityConstraints, localStreamRef, log, peersRef, roomType]
);

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
