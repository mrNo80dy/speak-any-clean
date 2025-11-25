"use client";

import { useEffect, useState } from "react";

// NOTE: This is a simplified placeholder hook to get the app compiling
// and give you local audio/video + controls. Remote streams will be
// wired up later with proper WebRTC + Supabase signaling.

type LiveParticipant = { id: string };

function useWebRTCHook(
  roomId: string,
  myPeerId: string,
  liveParticipants: LiveParticipant[]
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams] = useState<Record<string, MediaStream>>({});
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  // Get local media (audio + video)
  useEffect(() => {
    let cancelled = false;

    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: 1280, height: 720 },
      })
      .then((stream) => {
        if (!cancelled) {
          setLocalStream(stream);
        }
      })
      .catch((err) => {
        console.error("getUserMedia failed:", err);
      });

    return () => {
      cancelled = true;
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
      }
    };
    // we intentionally do NOT include localStream in deps to avoid
    // stopping/restarting it over and over
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, myPeerId]);

  const toggleAudio = () => {
    setAudioEnabled((prev) => {
      const next = !prev;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  };

  const toggleVideo = () => {
    setVideoEnabled((prev) => {
      const next = !prev;
      localStream?.getVideoTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  };

  return {
    localStream,
    remoteStreams,
    audioEnabled,
    videoEnabled,
    toggleAudio,
    toggleVideo,
  };
}

export default useWebRTCHook;
