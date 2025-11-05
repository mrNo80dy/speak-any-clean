"use client";
import { useEffect, useMemo, useRef, useState } from "react";

type Props = {
  localStream: MediaStream | null;
  peerConnections: Record<string, RTCPeerConnection>;
  audioEnabled: boolean;
  videoEnabled: boolean;
};

export function VideoGrid({ localStream, peerConnections }: Props) {
  const [selectedPeerId, setSelectedPeerId] = useState<string | "local">("local");

  const localMainRef = useRef<HTMLVideoElement>(null);
  const localThumbRef = useRef<HTMLVideoElement>(null);
  const remoteRefs = useRef<Record<string, HTMLVideoElement>>({});

  const remoteStreams = useMemo(() => {
    const entries = Object.entries(peerConnections);
    const map: Record<string, MediaStream | null> = {};
    for (const [peerId, pc] of entries) {
      // Grab the first remote stream from tracks
      const streams = pc.getReceivers()
        .map((r) => r.track)
        .filter(Boolean)
        // @ts-ignore
        .map((track: MediaStreamTrack) => new MediaStream([track]));
      // Combine all remote tracks into one stream per peer (video+audio)
      const combined = new MediaStream();
      for (const recv of pc.getReceivers()) {
        if (recv.track) combined.addTrack(recv.track);
      }
      map[peerId] = combined.getTracks().length ? combined : null;
    }
    return map;
  }, [peerConnections]);

  // Attach local streams to both main & thumb when selected
  useEffect(() => {
    const els = [localMainRef.current, localThumbRef.current].filter(Boolean) as HTMLVideoElement[];
    for (const el of els) {
      if (!el || !localStream) continue;
      el.srcObject = localStream;
      el.muted = true;
      el.playsInline = true as any; // iOS
      el.setAttribute("playsinline", "true");
      el.play().catch(() => {});
    }
  }, [localStream]);

  // Attach remote streams when elements mount / streams change
  useEffect(() => {
    for (const [peerId, stream] of Object.entries(remoteStreams)) {
      const el = remoteRefs.current[peerId];
      if (!el || !stream) continue;
      el.srcObject = stream;
      el.playsInline = true as any;
      el.setAttribute("playsinline", "true");
      el.autoplay = true;
      el.muted = false;
      el.play().catch(() => {});
    }
  }, [remoteStreams]);

  const remoteIds = Object.keys(remoteStreams).filter((id) => remoteStreams[id]);

  // Default selection: if any remote exists, show it as main
  useEffect(() => {
    if (selectedPeerId === "local" && remoteIds.length > 0) {
      setSelectedPeerId(remoteIds[0]);
    }
  }, [remoteIds, selectedPeerId]);

  return (
    <div className="h-full w-full flex flex-col">
      {/* Main video */}
      <div className="flex-1 bg-black flex items-center justify-center relative">
        {selectedPeerId === "local" ? (
          <video ref={localMainRef} className="max-h-full max-w-full object-contain" />
        ) : (
          <video
            id={`remote-main-${selectedPeerId}`}
            ref={(el) => {
              if (el) remoteRefs.current[selectedPeerId] = el;
            }}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>

      {/* Thumbnails */}
      <div className="w-full bg-gray-800 border-t border-gray-700 flex gap-2 p-2 overflow-x-auto">
        {/* Local thumbnail */}
        <video
          ref={localThumbRef}
          onClick={() => setSelectedPeerId("local")}
          className={`w-24 h-24 object-cover cursor-pointer border-2 ${
            selectedPeerId === "local" ? "border-blue-500" : "border-transparent"
          }`}
        />

        {/* Remote thumbnails */}
        {remoteIds.map((id) => (
          <video
            key={id}
            id={`remote-thumb-${id}`}
            ref={(el) => {
              if (el) remoteRefs.current[id] = el;
            }}
            onClick={() => setSelectedPeerId(id)}
            className={`w-24 h-24 object-cover cursor-pointer border-2 ${
              selectedPeerId === id ? "border-blue-500" : "border-transparent"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
