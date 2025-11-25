"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RealtimeChannel,
  RealtimeChannelSendResponse,
} from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

type SignalChannel = RealtimeChannel & {
  send: (args: {
    type: "broadcast";
    event: "signal";
    payload: any;
  }) => Promise<RealtimeChannelSendResponse>;
  isReady: () => boolean;
};

function createSignalChannel(roomId: string): SignalChannel {
  const base = supabase.channel(`signal-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let ready = false;
  const queue: Array<() => Promise<any>> = [];

  const safeSend: SignalChannel["send"] = (args) => {
    if (ready) return base.send(args as any);

    return new Promise((resolve, reject) => {
      queue.push(() => {
        const p = base.send(args as any);
        p.then(resolve).catch(reject);
        return p;
      });
    });
  };

  base.subscribe((status: string) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      const pending = queue.splice(0);
      pending.forEach((fn) => fn());
    }
  });

  return Object.assign(base, {
    send: safeSend,
    isReady: () => ready,
  });
}

function useWebRTCHook(
  roomId: string,
  myPeerId: string,
  liveParticipants: { id: string }[]
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>(
    {}
  );
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const pcs = useRef<Record<string, RTCPeerConnection>>({});
  const signalCh = useRef<SignalChannel | null>(null);

  // Get local media (audio + video)
  useEffect(() => {
    let stop = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: 1280, height: 720 },
      })
      .then((stream) => {
        if (!stop) setLocalStream(stream);
      })
      .catch((err) => console.error("getUserMedia failed:", err));

    return () => {
      stop = true;
    };
  }, []);

  const getPC = useCallback(
    (peerId: string) => {
      if (pcs.current[peerId]) return pcs.current[peerId];

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      if (localStream) {
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      }

      pc.ontrack = ({ streams }) => {
        const stream = streams[0];
        if (stream) {
          setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
        }
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !signalCh.current) return;
        signalCh.current.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: peerId,
            type: "ice",
            candidate: ev.candidate.toJSON(),
          },
        });
      };

      pcs.current[peerId] = pc;
      return pc;
    },
    [localStream, myPeerId, roomId]
  );

  // Signaling channel for WebRTC offers/answers/candidates
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    const ch = createSignalChannel(roomId);
    signalCh.current = ch;

    ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!payload) return;
      const { sender_id, target_id, type, sdp, candidate } = payload;

      if (sender_id === myPeerId) return;
      if (target_id && target_id !== myPeerId) return;

      const pc = getPC(sender_id);

      if (type === "offer") {
        await pc.setRemoteDescription(sdp);
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
            sdp: answer,
          },
        });
      }

      if (type === "answer") {
        await pc.setRemoteDescription(sdp);
      }

      if (type === "ice" && candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn("addIceCandidate error:", err);
        }
      }
    });

    return () => {
      ch.unsubscribe();
      signalCh.current = null;
    };
  }, [roomId, myPeerId, getPC]);

  // Create offers to new participants
  useEffect(() => {
    liveParticipants.forEach(async (p) => {
      if (p.id === myPeerId) return;
      if (!pcs.current[p.id]) {
        const pc = getPC(p.id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        signalCh.current?.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: p.id,
            type: "offer",
            sdp: offer,
          },
        });
      }
    });
  }, [liveParticipants, myPeerId, roomId, getPC]);

  const toggleAudio = () => {
    setAudioEnabled((v) => {
      const next = !v;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  };

  const toggleVideo = () => {
    setVideoEnabled((v) => {
      const next = !v;
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

export default useWebRTCHook;      });
    });
  };

  base.subscribe((status: string) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      const pending = queue.splice(0);
      pending.forEach((fn) => fn());
    }
  });

  return Object.assign(base, {
    send: safeSend,
    isReady: () => ready,
  });
}

export function useWebRTC(
  roomId: string,
  myPeerId: string,
  liveParticipants: { id: string }[]
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const pcs = useRef<Record<string, RTCPeerConnection>>({});
  const signalCh = useRef<SignalChannel | null>(null);

  // Get local media (audio + video)
  useEffect(() => {
    let stop = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: 1280, height: 720 },
      })
      .then((stream) => {
        if (!stop) setLocalStream(stream);
      })
      .catch((err) => console.error("getUserMedia failed:", err));

    return () => {
      stop = true;
    };
  }, []);

  const getPC = useCallback(
    (peerId: string) => {
      if (pcs.current[peerId]) return pcs.current[peerId];

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      if (localStream) {
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      }

      pc.ontrack = ({ streams }) => {
        const stream = streams[0];
        if (stream) {
          setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
        }
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !signalCh.current) return;
        signalCh.current.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: peerId,
            type: "ice",
            candidate: ev.candidate.toJSON(),
          },
        });
      };

      pcs.current[peerId] = pc;
      return pc;
    },
    [localStream, myPeerId, roomId]
  );

  // Signaling channel for WebRTC offers/answers/candidates
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    const ch = createSignalChannel(roomId);
    signalCh.current = ch;

    ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!payload) return;
      const { sender_id, target_id, type, sdp, candidate } = payload;

      if (sender_id === myPeerId) return;
      if (target_id && target_id !== myPeerId) return;

      const pc = getPC(sender_id);

      if (type === "offer") {
        await pc.setRemoteDescription(sdp);
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
            sdp: answer,
          },
        });
      }

      if (type === "answer") {
        await pc.setRemoteDescription(sdp);
      }

      if (type === "ice" && candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn("addIceCandidate error:", err);
        }
      }
    });

    return () => {
      ch.unsubscribe();
      signalCh.current = null;
    };
  }, [roomId, myPeerId, getPC]);

  // Create offers to new participants
  useEffect(() => {
    liveParticipants.forEach(async (p) => {
      if (p.id === myPeerId) return;
      if (!pcs.current[p.id]) {
        const pc = getPC(p.id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        signalCh.current?.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: p.id,
            type: "offer",
            sdp: offer,
          },
        });
      }
    });
  }, [liveParticipants, myPeerId, roomId, getPC]);

  const toggleAudio = () => {
    setAudioEnabled((v) => {
      const next = !v;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  };

  const toggleVideo = () => {
    setVideoEnabled((v) => {
      const next = !v;
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
}        return p;
      });
    });
  };

  base.subscribe((status: RealtimeChannelStatus) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      const pending = queue.splice(0);
      pending.forEach((fn) => fn());
    }
  });

  return Object.assign(base, {
    send: safeSend,
    isReady: () => ready,
  });
}

export function useWebRTC(
  roomId: string,
  myPeerId: string,
  liveParticipants: { id: string }[]
) {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);

  const pcs = useRef<Record<string, RTCPeerConnection>>({});
  const signalCh = useRef<SignalChannel | null>(null);

  // Get local media (audio + video)
  useEffect(() => {
    let stop = false;
    navigator.mediaDevices
      .getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: 1280, height: 720 },
      })
      .then((stream) => {
        if (!stop) setLocalStream(stream);
      })
      .catch((err) => console.error("getUserMedia failed:", err));

    return () => {
      stop = true;
    };
  }, []);

  const getPC = useCallback(
    (peerId: string) => {
      if (pcs.current[peerId]) return pcs.current[peerId];

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      if (localStream) {
        localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));
      }

      pc.ontrack = ({ streams }) => {
        const stream = streams[0];
        if (stream) {
          setRemoteStreams((prev) => ({ ...prev, [peerId]: stream }));
        }
      };

      pc.onicecandidate = (ev) => {
        if (!ev.candidate || !signalCh.current) return;
        signalCh.current.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: peerId,
            type: "ice",
            candidate: ev.candidate.toJSON(),
          },
        });
      };

      pcs.current[peerId] = pc;
      return pc;
    },
    [localStream, myPeerId, roomId]
  );

  // Signaling channel for WebRTC offers/answers/candidates
  useEffect(() => {
    if (!roomId || !myPeerId) return;

    const ch = createSignalChannel(roomId);
    signalCh.current = ch;

    ch.on("broadcast", { event: "signal" }, async ({ payload }) => {
      if (!payload) return;
      const { sender_id, target_id, type, sdp, candidate } = payload;

      if (sender_id === myPeerId) return;
      if (target_id && target_id !== myPeerId) return;

      const pc = getPC(sender_id);

      if (type === "offer") {
        await pc.setRemoteDescription(sdp);
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
            sdp: answer,
          },
        });
      }

      if (type === "answer") {
        await pc.setRemoteDescription(sdp);
      }

      if (type === "ice" && candidate) {
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn("addIceCandidate error:", err);
        }
      }
    });

    return () => {
      ch.unsubscribe();
      signalCh.current = null;
    };
  }, [roomId, myPeerId, getPC]);

  // Create offers to new participants
  useEffect(() => {
    liveParticipants.forEach(async (p) => {
      if (p    };
  }, [roomId, myPeerId, getPC]);

  useEffect(() => {
    liveParticipants.forEach(async (p) => {
      if (p.id === myPeerId) return;
      if (!pcs.current[p.id]) {
        const pc = getPC(p.id);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        signalCh.current?.send({
          type: "broadcast",
          event: "signal",
          payload: {
            room_id: roomId,
            sender_id: myPeerId,
            target_id: p.id,
            type: "offer",
            sdp: offer,
          },
        });
      }
    });
  }, [liveParticipants, myPeerId, roomId, getPC]);

  const toggleAudio = () => {
    setAudioEnabled((v) => {
      const next = !v;
      localStream?.getAudioTracks().forEach((t) => (t.enabled = next));
      return next;
    });
  };

  const toggleVideo = () => {
    setVideoEnabled((v) => {
      const next = !v;
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



