"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

type PeerMap = Record<string, RTCPeerConnection>;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

/** The exact arg shape Supabase `channel.send` accepts */
type SignalArgs = {
  type: "broadcast" | "presence" | "postgres_changes";
  event: string;
  payload?: any;
  [key: string]: any;
};

/** A Realtime channel with a safe, promise-returning send and a readiness flag */
type SignalChannel = RealtimeChannel & {
  send: (args: SignalArgs, opts?: Record<string, any>) => Promise<RealtimeChannelSendResponse>;
  isReady: () => boolean;
};

/** Inline signaling channel that is safe to call `send()` before SUBSCRIBED */
function createInlineSignalChannel(roomId: string): SignalChannel {
  const base = supabase.channel(`signal-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let ready = false;

  // Queue thunks that actually perform the send and resolve/reject the original promise.
  const queue: Array<() => Promise<RealtimeChannelSendResponse>> = [];

  const safeSend: SignalChannel["send"] = (args, opts) => {
    if (ready) {
      return base.send(args as any, opts as any);
    }
    return new Promise<RealtimeChannelSendResponse>((resolve, reject) => {
      queue.push(() =>
        base.send(args as any, opts as any).then(resolve).catch(reject)
      );
    });
  };

  base.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      const pending = queue.splice(0);
      for (const run of pending) run();
    }
  });

  return Object.assign(base, {
    send: safeSend,
    isReady: () => ready,
  }) as SignalChannel;
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

  // Get local media when we have a room and peer id
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
      // We keep tracks alive; toggles/cleanup handled elsewhere.
    };
  }, [roomId, myPeerId]);

  // helper: get or create PC to a peer
  const getOrCreatePC = useCallback(
    (otherId: string) => {
      const existing = peerConnectionsRef.current[otherId];
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      // add local tracks
      if (localStream) {
        for (const track of localStream.getTracks()) {
          pc.addTrack(track, localStream);
        }
      }

      // remote tracks consumed elsewhere (e.g., a VideoGrid reading receivers)
      pc.ontrack = () => {};

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !signalChRef.current || !roomId || !myPeerId) return;
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
        }).catch((e) => console.warn("send ice failed:", e));
      };

      // try ICE restart on disconnect
      pc.oniceconnectionstatechange = async () => {
        if (pc.iceConnectionState === "disconnected") {
          setTimeout(async () => {
            try {
              const offer = await pc.createOffer({ iceRestart: true });
              await pc.setLocalDescription(offer);
              await signalChRef.current?.send({
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

  // create an offer to a peer
  const createOfferTo = useCallback(
    async (otherId: string) => {
      const pc = getOrCreatePC(otherId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await signalChRef.current?.send({
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

  // subscribe to signaling for this room
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    const ch = createInlineSignalChannel(roomId)
      .on("broadcast", { event: "signal" }, async ({ payload }) => {
        if (!payload) return;
        const { sender_id, target_id, type, sdp, candidate } = payload;

        if (sender_id === myPeerId) return; // ignore own signals
        if (target_id && target_id !== myPeerId) return; // not for me

        const pc = getOrCreatePC(sender_id);

        if (type === "offer" && sdp) {
          await pc.setRemoteDescription(sdp as RTCSessionDescriptionInit);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          await ch.send({
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

    signalChRef.current = ch; // <- ch is a SignalChannel

    return () => {
      ch.unsubscribe();
      signalChRef.current = null;
    };
  }, [roomId, myPeerId, getOrCreatePC]);

  // when live participants change, offer to any new ones
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
