"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from "@supabase/supabase-js";

// ...after you create `ch`:
let ready = false;

// Queue thunks that, when run, will perform the actual send and resolve/reject a promise.
const queue: Array<() => Promise<RealtimeChannelSendResponse>> = [];

// Typed exactly as Supabase expects:
const safeSend: RealtimeChannel["send"] = (args, opts) => {
  if (ready) {
    // when ready, just send and return the Promise the SDK returns
    return ch.send(args as any, opts);
  }

  // not ready: return a Promise and queue the actual send
  return new Promise<RealtimeChannelSendResponse>((resolve, reject) => {
    queue.push(() =>
      ch.send(args as any, opts).then(resolve).catch(reject)
    );
  });
};

// mark ready + flush queue once subscribed
ch.subscribe((status) => {
  if (status === "SUBSCRIBED") {
    ready = true;
    // kick queued sends; don't await—each one resolves its own promise
    const pending = queue.splice(0);
    for (const run of pending) run();
  }
});

// wherever you previously did `ch.send(...)`, use `safeSend(...)` instead

import { supabase } from "@/lib/supabaseClient";

type PeerMap = Record<string, RTCPeerConnection>;
const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

// ---- Inline signaling channel (replaces `createSignalChannel` import) ----
function createInlineSignalChannel(roomId: string) {
  // Use a unique channel key per room
  const ch = supabase.channel(`signal-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let ready = false;
  const queue: Array<{ type: "broadcast"; event: string; payload: any }> = [];

  const flush = () => {
    if (!ready) return;
    while (queue.length) ch.send(queue.shift()!);
  };

  const safeSend: RealtimeChannel["send"] = (msg) => {
    if (!ready) queue.push(msg as any);
    else ch.send(msg as any);
    return ch;
  };

  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      flush();
    }
  });

  // mirror a tiny subset of RealtimeChannel API we use
  return Object.assign(ch, {
    send: safeSend,
    isReady: () => ready,
  });
}
// -------------------------------------------------------------------------

export function useWebRTC(
  roomId: string | null,
  myPeerId: string | null,
  liveParticipants: Array<{ id: string }>,
) {
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const peerConnectionsRef = useRef<PeerMap>({});
  const signalChRef = useRef<ReturnType<typeof createInlineSignalChannel> | null>(null);

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
      // leave tracks running; you toggle via controls or stop on leave
    };
  }, [roomId, myPeerId]);

  // helper: get or create pc
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

      // remote tracks are consumed by your <VideoGrid/> from pc.getReceivers()
      pc.ontrack = () => {
        // no-op here (VideoGrid reads streams from the PC)
      };

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
        });
      };

      // attempt ICE restart on disconnect
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
    [localStream, roomId, myPeerId],
  );

  // create an offer to a peer
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
    [getOrCreatePC, roomId, myPeerId],
  );

  // subscribe to signaling for this room
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

    signalChRef.current = ch;
    return () => {
      ch.unsubscribe();
      signalChRef.current = null;
    };
  }, [roomId, myPeerId, getOrCreatePC]);

  // when list of live participants changes, offer to any new ones
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

