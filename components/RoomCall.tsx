"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";
import { useWebRTC } from "@/hooks/use-webrtc-hook";

type RealtimeSubscribeStatus = 'SUBSCRIBED' | 'CLOSED' | 'TIMED_OUT' | 'CHANNEL_ERROR';
type PresenceUser = { id: string };

export default function RoomCall({ roomId }: { roomId: string }) {
  // Make a stable peer id for this browser tab
  const [myPeerId] = useState(() => crypto.randomUUID());

  // Presence: collect live participants for this room
  const [participants, setParticipants] = useState<PresenceUser[]>([]);

  // Join a presence channel keyed by room id
  useEffect(() => {
    const ch = supabase.channel(`presence-${roomId}`, {
      config: { presence: { key: myPeerId } },
    });

    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState() as Record<string, any[]>;
      const ids = Object.keys(state).map((id) => ({ id }));
      setParticipants(ids);
      // Debug
      console.log("[Presence] participants", ids);
    });

    ch.subscribe(async (status: RealtimeSubscribeStatus) => {
  if (status === 'SUBSCRIBED') {
    await ch.track({ online_at: Date.now() });
  }
});

    return () => {
      ch.unsubscribe();
    };
  }, [roomId, myPeerId]);

  // Use the WebRTC hook with presence list
  const {
    localStream,
    remoteStreams,
    audioEnabled,
    videoEnabled,
    toggleAudio,
    toggleVideo,
  } = useWebRTC(roomId, myPeerId, participants);

  // attach local stream to a <video>
  const localRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (localRef.current && localStream) {
      localRef.current.srcObject = localStream;
    }
  }, [localStream]);

  const remoteEntries = useMemo(() => Object.entries(remoteStreams), [remoteStreams]);

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-600">
        <div><span className="font-semibold">Room:</span> {roomId}</div>
        <div><span className="font-semibold">Me (peer):</span> {myPeerId.slice(0, 8)}</div>
        <div><span className="font-semibold">Live participants:</span> {participants.map(p => p.id.slice(0,8)).join(", ") || "(just you)"} </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Local video */}
        <div className="rounded-lg overflow-hidden bg-black aspect-video">
          <video
            ref={localRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        </div>

        {/* First remote (if any) */}
        {remoteEntries.length > 0 ? (
          remoteEntries.map(([peerId, stream]) => (
            <RemoteVideo key={peerId} stream={stream} label={`Peer ${peerId.slice(0,8)}`} />
          ))
        ) : (
          <div className="rounded-lg border flex items-center justify-center text-gray-500">
            Waiting for another participant to join…
          </div>
        )}
      </div>

      <div className="flex gap-3">
        <Button onClick={toggleAudio} variant={audioEnabled ? "default" : "secondary"}>
          {audioEnabled ? "Mute" : "Unmute"}
        </Button>
        <Button onClick={toggleVideo} variant={videoEnabled ? "default" : "secondary"}>
          {videoEnabled ? "Stop Video" : "Start Video"}
        </Button>
      </div>
    </div>
  );
}

function RemoteVideo({ stream, label }: { stream: MediaStream; label: string }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
  }, [stream]);
  return (
    <div className="rounded-lg overflow-hidden bg-black aspect-video relative">
      <video ref={ref} autoPlay playsInline className="w-full h-full object-cover" />
      <div className="absolute bottom-2 left-2 px-2 py-1 text-xs bg-black/60 text-white rounded">
        {label}
      </div>
    </div>
  );
}
