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
      // Try fast path first
      try {
        // @ts-ignore
        await oldTrack.applyConstraints({ facingMode: { ideal: nextFacing } });
        setFacingMode(nextFacing);
        log?.("camera flip (applyConstraints)", { nextFacing });
        return;
      } catch {
        // fall through
      }

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

      // Replace in local stream
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

      setFacingMode(nextFacing);
      log?.("camera flip (new track)", { nextFacing });
    } finally {
      switchingRef.current = false;
    }
  }, [facingMode, isMobile, localStreamRef, peersRef, roomType, log]);

  const canFlip = isMobile && roomType === "video";

  return {
    beforeConnect,
    toggleCamera,
    flipCamera,
    canFlip,
    facingMode,
  };
}
