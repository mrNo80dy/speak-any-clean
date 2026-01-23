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

function constraintsFor(isMobile: boolean, hd: boolean, facing: FacingMode): MediaTrackConstraints {
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

function constraintsForDeviceId(isMobile: boolean, hd: boolean, deviceId: string): MediaTrackConstraints {
  // When selecting a specific deviceId on Android, avoid mixing facingMode.
  const base: MediaTrackConstraints = isMobile
    ? { width: { ideal: hd ? 1280 : 960 }, height: { ideal: hd ? 720 : 540 } }
    : { width: { ideal: hd ? 1920 : 1280 }, height: { ideal: hd ? 1080 : 720 } };
  return { ...base, deviceId: { exact: deviceId } };
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

  const stopAndRemoveVideoTrack = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const old = stream.getVideoTracks()[0];
    if (!old) return;
    try {
      stream.removeTrack(old);
    } catch {}
    try {
      old.stop();
    } catch {}
  }, [localStreamRef]);

  const addNewVideoTrack = useCallback(
    (newTrack: MediaStreamTrack) => {
      const stream = localStreamRef.current;
      if (!stream) return;
      try {
        stream.addTrack(newTrack);
      } catch {}
      replaceOutgoingOnPeers(newTrack);
    },
    [localStreamRef, replaceOutgoingOnPeers]
  );

  const restartVideoTrack = useCallback(
    async (nextFacing: FacingMode, nextHd: boolean) => {
      if (!navigator?.mediaDevices?.getUserMedia) return;
      const stream = localStreamRef.current;
      if (!stream) return;

      stopAndRemoveVideoTrack();

      let newTrack: MediaStreamTrack | undefined;
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: constraintsFor(isMobile, nextHd, nextFacing),
          audio: false,
        });
        newTrack = newStream.getVideoTracks()[0];
      } catch {
        // looser fallback
        const fallbackStream = await navigator.mediaDevices.getUserMedia({
          video: nextHd
            ? { width: { ideal: 1280 }, height: { ideal: 720 } }
            : { width: { ideal: 640 }, height: { ideal: 360 } },
          audio: false,
        });
        newTrack = fallbackStream.getVideoTracks()[0];
      }

      if (newTrack) addNewVideoTrack(newTrack);
    },
    [addNewVideoTrack, isMobile, localStreamRef, stopAndRemoveVideoTrack]
  );

  const restartVideoTrackByDeviceId = useCallback(
    async (deviceId: string, nextHd: boolean) => {
      if (!navigator?.mediaDevices?.getUserMedia) return;
      const stream = localStreamRef.current;
      if (!stream) return;

      stopAndRemoveVideoTrack();

      const newStream = await navigator.mediaDevices.getUserMedia({
        video: constraintsForDeviceId(isMobile, nextHd, deviceId),
        audio: false,
      });
      const newTrack = newStream.getVideoTracks()[0];
      if (newTrack) addNewVideoTrack(newTrack);
    },
    [addNewVideoTrack, isMobile, localStreamRef, stopAndRemoveVideoTrack]
  );

  const applyQualityToExistingTrack = useCallback(
    async (nextHd: boolean, facing: FacingMode) => {
      const track = localStreamRef.current?.getVideoTracks()[0];
      if (!track || typeof track.applyConstraints !== "function") return false;
      try {
        await track.applyConstraints(constraintsFor(isMobile, nextHd, facing));
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

  const pickOtherDeviceId = async (): Promise<string | null> => {
    if (!navigator?.mediaDevices?.enumerateDevices) return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const vids = devices.filter((d) => d.kind === "videoinput");
    if (vids.length < 2) return null;

    const currentTrack = localStreamRef.current?.getVideoTracks?.()[0];
    const currentId = (currentTrack?.getSettings?.() as MediaTrackSettings | undefined)?.deviceId;

    // Heuristic: prefer switching away from current deviceId.
    const other = vids.find((d) => d.deviceId && d.deviceId !== currentId);
    return (other?.deviceId ?? vids[0]?.deviceId) || null;
  };

  const flipCamera = useCallback(
    async () => {
      if (!isMobile || roomType !== "video" || switchingRef.current) return;
      switchingRef.current = true;
      try {
        const nextFacing: FacingMode = facingModeRef.current === "user" ? "environment" : "user";
        facingModeRef.current = nextFacing;
        setFacingMode(nextFacing);

        // First: try facingMode restart.
        await restartVideoTrack(nextFacing, hdEnabled);

        // Many Android devices ignore facingMode and keep same device. If so, force deviceId swap.
        const desired = await pickOtherDeviceId();
        if (desired) {
          const afterTrack = localStreamRef.current?.getVideoTracks?.()[0];
          const afterId = (afterTrack?.getSettings?.() as MediaTrackSettings | undefined)?.deviceId;
          if (afterId === undefined || afterId === desired) {
            // already swapped or unknown; no-op
          } else {
            await restartVideoTrackByDeviceId(desired, hdEnabled);
          }
        }

        setTimeout(() => setCamEnabled(true), 80);
      } catch (e) {
        log?.("flipCamera failed", { e: String(e) });
      } finally {
        switchingRef.current = false;
      }
    },
    [hdEnabled, isMobile, log, restartVideoTrack, restartVideoTrackByDeviceId, roomType, setCamEnabled]
  );

  // Basic canFlip heuristic
  const canFlip = isMobile;

  return {
    toggleCamera,
    flipCamera,
    canFlip,
    facingMode,
    hdEnabled,
    setVideoQuality,
  };
}
