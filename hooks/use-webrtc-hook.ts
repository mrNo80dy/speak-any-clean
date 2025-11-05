"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

type PeerMap = Record<string, RTCPeerConnection>;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// An augmented channel type we will actually use everywhere.
type SignalChannel = RealtimeChannel & {
  // Keep Supabase's send signature but ensure it returns their Promise type.
  send: (
    args: {
      [key: string]: any;
      type: "postgres_changes" | "broadcast" | "presence";
      event: string;
      payload?: any;
    },
    opts?: { [key: string]: any }
  ) => Promise<RealtimeChannelSendResponse>;
  isReady: () => boolean;
};

/**
 * Create a per-room inline signaling channel that:
 *  - Buffers sends until the channel is SUBSCRIBED
 *  - Exposes a Promise-returning send(...) (matching Supabase)
 *  - Adds isReady() for convenience
 */
function createInlineSignalChannel(roomId: string): SignalChannel {
  const base: RealtimeChannel = supabase.channel(`signal-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let ready = false;
  // queued "thunks" that will send once ready
  const queue: Array<() => Promise<RealtimeChannelSendResponse>> = [];

  const safeSend: SignalChannel["send"] = (args, opts) => {
    if (ready) {
      // channel ready → just forward and return the SDK's promise
      return base.send(args as any, opts);
    }
    // not ready → return a promise that resolves/rejects when we flush
    return new Promise<RealtimeChannelSendResponse>((resolve, reject) => {
  queue.push(() => {
    const p = base.send(args as any, opts); // <- returns Promise<RealtimeChannelSendResponse>
    p.then(resolve, reject);                 // wire to the outer promise
    return p;                                // <- satisfy the thunk's return type
  });
});

  };

  base.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      // flush queued sends; each thunk resolves its own promise
      const pending = queue.splice(0);
      pending.forEach((run) => run());
    }
  });

  // Return the base channel, but with our overrides/augmentations.
  const augmented: SignalChannel = Object.assign(base, {
    send: safeSend,
    isReady: () => ready,
  });

  return augmented;
}

export function useWebRTC(
  roomId: string | null,
  myPeerId: string | null,
  liveParticipants: Array<{ id: string }>
) {
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const peerConnectionsRef = useRef<PeerMap>({});
  const signalChRef = useRef<SignalChannel | null>(null);

  // Grab mic/cam once we have room + id
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    let stopped = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        });
        if (!stopped) setLocalStream(stream);
      } catch (err) {
        console.error("getUserMedia failed:", err);
      }
    })();

    return () => {
      stopped = true;
    };
  }, [roomId, myPeerId]);

  // Get or create a peer connection for a given peer id
  const getOrCreatePC = useCallback(
    (otherId: string) => {
      const existing = peerConnectionsRef.current[otherId];
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      if (localStream) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      pc.ontrack = () => {
        // Your UI (e.g., <VideoGrid/>) should read from pc.getReceivers()
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !signalChRef.current || !roomId || !myPeerId) return;
        void signalChRef.current.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: otherId,
            type: "ice",
            candidate: ev.candidate.toJSON(),
          },
        });
      };

      pc.oniceconnectionstatechange = async () => {
        if (pc.iceConnectionState === "disconnected") {
          setTimeout(async () => {
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              if (!signalChRef.current || !roomId || !myPeerId) return;
              await signalChRef.current.send({
                type: "broadcast",
                event: "signal",
                payload: {
                  room_id: roomId,
                  sender_id: myPeerId,
                  target_id: otherId,
                  type: "offer",
                  sdp: { type: offer.type, sdp: offer.sdp },
                },
              });
            } catch (e) {
              console.warn("ICE restart failed:", e);
            }
          }, 2500);
        }
      };

      peerConnectionsRef.current[otherId] = pc;
      return pc;
    },
    [localStream, roomId, myPeerId]
  );

  // Create an offer to a peer
  const createOfferTo = useCallback(
    async (otherId: string) => {
      const pc = getOrCreatePC(otherId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (!signalChRef.current || !roomId || !myPeerId) return;
      await signalChRef.current.send({
        type: "broadcast",
        event: "signal",
        payload: {
          room_id: roomId,
          sender_id: myPeerId,
          target_id: otherId,
          type: "offer",
          sdp: { type: offer.type, sdp: offer.sdp },
        },
      });
    },
    [getOrCreatePC, roomId, myPeerId]
  );

  // Subscribe to signaling for this room
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    const ch = createInlineSignalChannel(roomId); // ch is SignalChannel

ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
  if (!payload) return;
  const { sender_id, target_id, type, sdp, candidate } = payload;

  if (sender_id === myPeerId) return;
  if (target_id && target_id !== myPeerId) return;

  const pc = getOrCreatePC(sender_id);

  if (type === "offer" && sdp) {
    await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await ch.send({
      type: "broadcast",
      event: "signal",
      payload: {
        room_id: roomId!,
        sender_id: myPeerId!,
        target_id: sender_id,
        type: "answer",
        sdp: { type: answer.type, sdp: answer.sdp },
      },
    });
  } else if (type === "answer" && sdp) {
    await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
  } else if (type === "ice" && candidate) {
    try {
      await pc.addIceCandidate(candidate as RTCIceCandidateInit);
    } catch (e) {
      console.error("addIceCandidate failed:", e);
    }
  }
});

ch.subscribe();

signalChRef.current = ch; // stays SignalChannel (has isReady + patched send)


    signalChRef.current = ch; // ch is SignalChannel
    return () => {
      ch.unsubscribe();
      signalChRef.current = null;
    };
  }, [roomId, myPeerId, getOrCreatePC]);

  // When participants list changes, offer to any new ones
  useEffect(() => {
    if (!roomId || !myPeerId) return;
    (async () => {
      for (const p of liveParticipants) {
        if (p.id !== myPeerId && !peerConnectionsRef.current[p.id]) {
          await createOfferTo(p.id);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, myPeerId, liveParticipants.map((p) => p.id).join(",")]);

  const toggleAudio = useCallback(() => {
    setAudioEnabled((v) => {
      const next = !v;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, [localStream]);

  const toggleVideo = useCallback(() => {
    setVideoEnabled((v) => {
      const next = !v;
      localStream?.getVideoTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  }, [localStream]);

  const peerConnections = useMemo(() => peerConnectionsRef.current, []);

  return {
    localStream,
    peerConnections,
    audioEnabled,
    videoEnabled,
    toggleAudio,
    toggleVideo,
  };
}


