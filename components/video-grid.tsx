"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type VideoGridProps = {
  localStream: MediaStream | null;
  remoteStreams: Record<string, MediaStream>;
  audioEnabled: boolean;
  videoEnabled: boolean;
};

export function VideoGrid({
  localStream,
  remoteStreams,
}: VideoGridProps) {
  const [selectedPeerId, setSelectedPeerId] = useState<string | "local">("local");

  const localMainRef = useRef<HTMLVideoElement>(null);
  const localThumbRef = useRef<HTMLVideoElement>(null);
  const remoteRefs = useRef<Record<string, HTMLVideoElement>>({});

  const remoteIds = useMemo(
    () => Object.keys(remoteStreams),
    [remoteStreams]
  );

  // Attach local stream to main & thumbnail
  useEffect(() => {
    const elements = [localMainRef.current, localThumbRef.current].filter(
      Boolean
    ) as HTMLVideoElement[];

    for (const el of elements) {
      if (!el || !localStream) continue;
      el.srcObject = localStream;
      el.muted = true;
      el.playsInline = true as any;
      el.setAttribute("playsinline", "true");
      el
        .play()
        .catch(() => {
          /* ignore autoplay errors */
        });
    }
  }, [localStream]);

  // Attach remote streams to refs
  useEffect(() => {
    for (const [peerId, stream] of Object.entries(remoteStreams)) {
      const el = remoteRefs.current[peerId];
      if (!el || !stream) continue;
      el.srcObject = stream;
      el.playsInline = true as any;
      el.setAttribute("playsinline", "true");
      el.autoplay = true;
      el.muted = false;
      el
        .play()
        .catch(() => {
          /* ignore autoplay errors */
        });
    }
  }, [remoteStreams]);

  // Default selection: if a remote exists, show it as main
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
          <video
            ref={localMainRef}
            className="max-h-full max-w-full object-contain"
          />
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
            selectedPeerId === "local"
              ? "border-blue-500"
              : "border-transparent"
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
              selectedPeerId === id
                ? "border-blue-500"
                : "border-transparent"
            }`}
          />
        ))}
      </div>
    </div>
  );
}
