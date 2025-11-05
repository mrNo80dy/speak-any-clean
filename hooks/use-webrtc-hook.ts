"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

type PeerMap = Record<string, RTCPeerConnection>;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/* A RealtimeChannel that also exposes a Promise-returning `send` (same signature
   as Supabase) and an `isReady()` helper so we can gate queued sends. */
type SignalChannel = RealtimeChannel & {
  send: RealtimeChannel["send"];
  isReady: () => boolean;
};

/* -------------------------------------------------------------------------- */
/*                       Inline Supabase Realtime Channel                      */
/* -------------------------------------------------------------------------- */
function createInlineSignalChannel(roomId: string): SignalChannel {
  const ch: RealtimeChannel = supabase.channel(`signal-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let ready = false;

  type QueuedItem = {
    fn: () => Promise<RealtimeChannelSendResponse>;
    resolve: (v: RealtimeChannelSendResponse) => void;
    reject: (e: unknown) => void;
  };

  const queue: QueuedItem[] = [];

  const safeSend: RealtimeChannel["send"] = (args, opts) => {
    if (ready) {
      // When ready, return the SDK's Promise directly
      return ch.send(args as any, opts);
    }

    // Not ready yet: return a Promise and enqueue how to resolve it
    return new Promise<RealtimeChannelSendResponse>((resolve, reject) => {
      queue.push({
        fn: () => ch.send(args as any, opts),
        resolve,
        reject,
      });
    });
  };

  const flush = () => {
    if (!ready || queue.length === 0) return;
    const pending = queue.splice(0);
    for (const q of pending) q.fn().then(q.resolve).catch(q.reject);
  };

  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      flush();
    }
  });

  // Return an explicitly-typed augmented channel
  const wrapped: SignalChannel = Object.assign(ch, {
    send: safeSend,
    isReady: () => ready,
  });

  return wrapped;
}

/* -------------------------------------------------------------------------- */
/*                                WebRTC Hook                                 */
/* -------------------------------------------------------------------------- */
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

  /* ---------------------------- Get Local Media ---------------------------- */
  useEffect(() => {
    if (!roomId || !myPeerId) return;
    let stopped = false;

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: "user",
          },
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

  /* ---------------------------- Peer Connection ---------------------------- */
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

      // VideoGrid reads remote tracks; nothing else needed here
      pc.ontrack = () => {};

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !signalChRef.current || !roomId || !myPeerId)
          return;
        signalChRef.current.send({
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

      // Try ICE restart on disconnect
      pc.oniceconnectionstatechange = async () => {
        if (pc.iceConnectionState === "disconnected") {
          setTimeout(async () => {
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              signalChRef.current?.send({
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

  /* ----------------------------- Create Offer ----------------------------- */
  const createOfferTo = useCallback(
    async (otherId: string) => {
      const pc = getOrCreatePC(otherId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      signalChRef.current?.send({
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

  /* ----------------------------- Subscriptions ----------------------------- */
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    const ch = createInlineSignalChannel(roomId)
      .on("broadcast", { event: "signal" }, async ({ payload }) => {
        if (!payload) return;
        const { sender_id, target_id, type, sdp, candidate } = payload;
        if (sender_id === myPeerId) return;
        if (target_id && target_id !== myPeerId) return;

        const pc = getOrCreatePC(sender_id);

        if (type === "offer" && sdp) {
          await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          ch.send({
            type: "broadcast",
            event: "signal",
            payload: {
              room_id: roomId,
              sender_id: myPeerId,
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
      })
      .subscribe();

    signalChRef.current = ch; // <- ch is SignalChannel now
    return () => {
      ch.unsubscribe();
      signalChRef.current = null;
    };
  }, [roomId, myPeerId, getOrCreatePC]);

  /* -------- Offer to any new participants automatically when they appear --- */
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

  /* ------------------------------- Toggles ------------------------------- */
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
