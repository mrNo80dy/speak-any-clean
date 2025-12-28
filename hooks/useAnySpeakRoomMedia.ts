"use client";

import { useCallback } from "react";

type RoomType = "audio" | "video";

export type AnySpeakRoomMediaArgs = {
  isMobile: boolean;
  roomType: RoomType | null;
  joinCamOn: boolean | null;
  acquire: () => Promise<void>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  setCamEnabled: (enabled: boolean) => void;
  log: (msg: string, data?: any) => void;
};

/**
 * Hook #3: Room media policy.
 *
 * Goal: keep RoomPage stable while isolating camera + getUserMedia decisions
 * so we can iterate on camera behavior without touching WebRTC/STT.
 */
export function useAnySpeakRoomMedia({
  isMobile,
  roomType,
  joinCamOn,
  acquire,
  localStreamRef,
  setCamEnabled,
  log,
}: AnySpeakRoomMediaArgs) {
  const beforeConnect = useCallback(async () => {
    // ✅ Acquire media only if needed.
    // - Mobile never grabs mic (Web Speech uses mic)
    // - Video rooms grab camera; audio rooms do not
    const needVideo = roomType === "video";
    const canAcquire = !(isMobile && roomType === "audio") && (needVideo || !isMobile);

    if (canAcquire) {
      await acquire();

      log("local media acquired", {
        audioTracks: localStreamRef.current?.getAudioTracks().length ?? 0,
        videoTracks: localStreamRef.current?.getVideoTracks().length ?? 0,
        roomType,
      });

      // ✅ Mobile: free the mic for Web Speech STT (even in video mode)
      if (isMobile && localStreamRef.current) {
        const ats = localStreamRef.current.getAudioTracks();
        ats.forEach((t) => {
          try {
            t.stop();
          } catch {}
          try {
            localStreamRef.current?.removeTrack(t);
          } catch {}
        });
        if (ats.length) {
          log("mobile: removed local audio tracks to unblock STT", { removed: ats.length });
        }
      }
    } else {
      log("skipping getUserMedia (mobile STT-only audio room)", { roomType });
    }

    // ✅ Enforce camera state based on room type + joiner choice
    if (roomType === "video") {
      const wantCam = joinCamOn === null ? true : joinCamOn;
      setCamEnabled(wantCam);
      const vt = localStreamRef.current?.getVideoTracks?.()[0];
      if (vt) vt.enabled = wantCam;
      log("forced cam state (video room)", { wantCam });
    } else {
      setCamEnabled(false);
      const vt = localStreamRef.current?.getVideoTracks?.()[0];
      if (vt) vt.enabled = false;
      log("forced cam OFF (audio room)", {});
    }
  }, [acquire, isMobile, joinCamOn, localStreamRef, log, roomType, setCamEnabled]);

  const toggleCamera = useCallback(async () => {
    if (roomType !== "video") return;
    const s = localStreamRef.current;
    const vt = s?.getVideoTracks?.()[0] || null;
    if (!vt) return;
    setCamEnabled(!vt.enabled);
  }, [localStreamRef, roomType, setCamEnabled]);

  return { beforeConnect, toggleCamera };
}
