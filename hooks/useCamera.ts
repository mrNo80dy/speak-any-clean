"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

type VideoDevice = { deviceId: string; label: string };

function isLikelyBuiltIn(label: string) {
  const s = (label || "").toLowerCase();
  return (
    s.includes("integrated") ||
    s.includes("built-in") ||
    s.includes("builtin") ||
    s.includes("facetime") ||
    s.includes("imaging") ||
    s.includes("hd webcam") ||
    s.includes("internal")
  );
}

function pickPreferredDevice(devs: VideoDevice[]) {
  if (!devs.length) return null;

  // If we saved a specific camera last time, prefer it.
  try {
    const saved = localStorage.getItem("anyspeak.videoDeviceId") || "";
    if (saved) {
      const match = devs.find((d) => d.deviceId === saved);
      if (match) return match.deviceId;
    }
  } catch {}

  // If labels are available, prefer a non-built-in camera when present.
  const labeled = devs.filter((d) => (d.label || "").trim().length > 0);
  if (labeled.length) {
    const external = labeled.find((d) => !isLikelyBuiltIn(d.label));
    if (external) return external.deviceId;
  }

  // Fallback: first device.
  return devs[0].deviceId;
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
  const switchingRef = useRef(false);

  const [videoDevices, setVideoDevices] = useState<VideoDevice[]>([]);
  const [activeDeviceId, setActiveDeviceId] = useState<string | null>(null);

  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

  const refreshDevices = useCallback(async (): Promise<VideoDevice[]> => {
    if (!md?.enumerateDevices) return [];
    try {
      const all = await md.enumerateDevices();
      const vids = all
        .filter((d) => d.kind === "videoinput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label || "" }));
      setVideoDevices(vids);

      // Try to detect which device we're currently using.
      const vt = localStreamRef.current?.getVideoTracks?.()?.[0];
      const settings: any = vt?.getSettings ? vt.getSettings() : {};
      const currentId = (settings?.deviceId as string | undefined) || null;
      if (currentId) setActiveDeviceId(currentId);
      return vids;
    } catch {
      return [];
    }
  }, [localStreamRef, md]);

  // Refresh device list after the first permission grant (or whenever we toggle on).
  useEffect(() => {
    void refreshDevices();
  }, [refreshDevices]);

  const canFlip = useMemo(() => {
    if (roomType !== "video") return false;
    // Mobile: facingMode flip.
    if (isMobile) return true;
    // Desktop: only show if more than 1 camera is available.
    return videoDevices.length >= 2;
  }, [isMobile, roomType, videoDevices.length]);

  const replaceVideoTrack = useCallback(
    async (constraints: MediaTrackConstraints) => {
      if (!md?.getUserMedia) return;

      const currentStream = localStreamRef.current;
      const oldTrack = currentStream?.getVideoTracks?.()?.[0] ?? null;

      // Stop the old track so browsers release the previous camera cleanly (mobile camera flip depends on this).
      try {
        oldTrack?.stop?.();
      } catch {}
      if (!currentStream) return;

      const newStream = await md.getUserMedia({ video: constraints, audio: false });
      const newTrack = newStream.getVideoTracks()[0] || null;
      if (!newTrack) return;

      try {
        if (oldTrack) currentStream.removeTrack(oldTrack);
      } catch {}
      try {
        oldTrack?.stop();
      } catch {}
      try {
        currentStream.addTrack(newTrack);
      } catch {}

      // Replace on all peer connections so remote updates without renegotiation.
      if (peersRef?.current) {
        peersRef.current.forEach(({ pc }) => {
          try {
            const sender = pc.getSenders().find((s) => s.track?.kind === "video");
            if (sender) sender.replaceTrack(newTrack);
          } catch {}
        });
      }

      // Persist device choice when applicable.
      try {
        const st: any = newTrack.getSettings ? newTrack.getSettings() : {};
        const did = (st?.deviceId as string | undefined) || null;
        if (did) {
          setActiveDeviceId(did);
          localStorage.setItem("anyspeak.videoDeviceId", did);
        }
      } catch {}

      void refreshDevices();
    },
    [localStreamRef, md, peersRef, refreshDevices]
  );

  const ensurePreferredDesktopCamera = useCallback(async () => {
    if (isMobile) return;
    if (roomType !== "video") return;
    if (!md?.getUserMedia || !md?.enumerateDevices) return;

    // Make sure we have permission so labels/deviceIds are populated.
    const vids = await refreshDevices();
    const devId = pickPreferredDevice(vids.length ? vids : videoDevices);
    if (!devId) return;

    // If already using it, nothing to do.
    if (activeDeviceId && activeDeviceId === devId) return;

    await replaceVideoTrack({
      deviceId: { exact: devId },
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24, max: 30 },
    });
    log?.("camera select (desktop)", { deviceId: devId });
  }, [activeDeviceId, isMobile, log, md, refreshDevices, replaceVideoTrack, roomType, videoDevices]);

  const beforeConnect = useCallback(async () => {
    if (roomType !== "video") {
      setCamEnabled(false);
      return;
    }

    if (!joinCamOn) {
      setCamEnabled(false);
      return;
    }

    try {
      await acquire();
      setCamEnabled(true);

      // Desktop: after we have a stream, prefer the saved/external camera.
      await ensurePreferredDesktopCamera();
    } catch {
      setCamEnabled(false);
    }
  }, [acquire, ensurePreferredDesktopCamera, joinCamOn, roomType, setCamEnabled]);

  const toggleCamera = useCallback(async () => {
    if (roomType !== "video") return;

    const stream = localStreamRef.current;
    const currentlyOn = !!(stream && stream.getVideoTracks().some((t) => t.enabled));
    const next = !currentlyOn;

    if (next) {
      try {
        await acquire();
      } catch {}

      // Default to selfie cam when turning back on.
      setFacingMode("user");

      // Desktop: immediately switch to the preferred device if available.
      await ensurePreferredDesktopCamera();
    }

    setCamEnabled(next);
  }, [acquire, ensurePreferredDesktopCamera, localStreamRef, roomType, setCamEnabled]);

  const flipCamera = useCallback(async () => {
    if (roomType !== "video") return;
    if (switchingRef.current) return;

    const currentStream = localStreamRef.current;
    const oldTrack = currentStream?.getVideoTracks?.()[0] ?? null;
    if (!currentStream || !oldTrack) return;

    switchingRef.current = true;

    try {
      if (!md?.getUserMedia) return;

      // Mobile: flip between user/environment.
      if (isMobile) {
        const nextFacing: FacingMode = facingMode === "user" ? "environment" : "user";

        // Prefer an explicit facingMode switch. Some mobile browsers ignore `ideal`, so try `exact` first.
        try {
          await replaceVideoTrack({
            facingMode: { exact: nextFacing },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          });
        } catch {
          // Fallback: choose a deviceId by label (requires permissions already granted).
          const vids = await refreshDevices();
          const list = vids.length ? vids : videoDevices;
          const wantRear = nextFacing === "environment";
          const re = wantRear
            ? /(rear|back|environment|traseira|wide|ultra|tele)/i
            : /(front|user|facetime|selfie|frontal)/i;

          const chosen =
            list.find((d) => re.test(d.label || "")) ||
            // If labels are empty, at least alternate between device ids if possible.
            (list.length >= 2 ? list[1] : list[0]);

          if (chosen?.deviceId) {
            await replaceVideoTrack({
              deviceId: { exact: chosen.deviceId },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            });
          } else {
            // Last resort: try `ideal` if nothing else worked.
            await replaceVideoTrack({
              facingMode: { ideal: nextFacing },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            });
          }
        }

        setFacingMode(nextFacing);
        log?.("camera flip (mobile)", { nextFacing });
        return;
      }

      // Desktop: cycle through available cameras.
      const vids = await refreshDevices();
      const list = vids.length ? vids : videoDevices;
      const ids = list.map((d) => d.deviceId).filter(Boolean);
      if (ids.length < 2) return;

      const current = activeDeviceId || pickPreferredDevice(list) || ids[0];
      const idx = Math.max(0, ids.indexOf(current));
      const nextId = ids[(idx + 1) % ids.length];

      await replaceVideoTrack({
        deviceId: { exact: nextId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 24, max: 30 },
      });
      log?.("camera flip (desktop)", { nextId });
    } finally {
      switchingRef.current = false;
    }
  }, [
    activeDeviceId,
    facingMode,
    isMobile,
    localStreamRef,
    log,
    md,
    refreshDevices,
    replaceVideoTrack,
    roomType,
    videoDevices,
  ]);

  return {
    beforeConnect,
    toggleCamera,
    flipCamera,
    canFlip,
    facingMode,
  };
}
