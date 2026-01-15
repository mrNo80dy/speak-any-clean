"use client";

import { useCallback, useRef } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";

export type AnySpeakPeer = {
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
};

export type AnySpeakWebRtcArgs = {
  clientId: string;
  isMobile: boolean;
  iceServers: RTCIceServer[];
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  peersRef: React.MutableRefObject<Map<string, AnySpeakPeer>>;
  shouldMuteRawAudioRef: React.MutableRefObject<boolean>;
  setConnected: (v: boolean) => void;
  log: (msg: string, data?: any) => void;
  upsertPeerStream: (remoteId: string, stream: MediaStream) => void;
};

// WebRTC helpers extracted from Room page
export function useAnySpeakWebRtc(args: AnySpeakWebRtcArgs) {
  const {
    clientId,
    isMobile,
    iceServers,
    localStreamRef,
    peersRef,
    shouldMuteRawAudioRef,
    setConnected,
    log,
    upsertPeerStream,
  } = args;

  // ---- ICE candidate queue (pre-SDP safety)
  const pendingIceRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());

  // Camera startup can be slightly delayed (especially on mobile). If we create an
  // offer/answer before the local video track exists, the SDP may omit video and the
  // remote side will never receive it. This waits briefly for a video track when a
  // local stream exists.
  const waitForLocalVideoTrack = useCallback(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // If we have no local stream yet, nothing to wait for.
    if (!localStreamRef.current) return;

    // If camera is intentionally off, don't block.
    const hasAnyVideo = localStreamRef.current.getVideoTracks().length > 0;
    if (hasAnyVideo) return;

    // Wait up to ~1s for the camera track to appear.
    for (let i = 0; i < 20; i++) {
      if (!localStreamRef.current) return;
      if (localStreamRef.current.getVideoTracks().length > 0) return;
      await sleep(50);
    }
  }, [localStreamRef]);

  const clearPendingIce = useCallback(() => {
    pendingIceRef.current.clear();
  }, []);

  const enqueueIce = useCallback((fromId: string, candidate: RTCIceCandidateInit) => {
    const map = pendingIceRef.current;
    const list = map.get(fromId) ?? [];
    list.push(candidate);
    map.set(fromId, list);
  }, []);

  const flushIce = useCallback(
    async (fromId: string) => {
      const peer = peersRef.current.get(fromId);
      if (!peer) return;

      const pc = peer.pc;
      if (!pc.remoteDescription) return;

      const map = pendingIceRef.current;
      const list = map.get(fromId);
      if (!list || list.length === 0) return;

      map.delete(fromId);

      for (const c of list) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(c));
          log("flushed ice", { from: fromId });
        } catch (err) {
          log("flush ice error", { err: (err as Error).message });
        }
      }
    },
    [log, peersRef]
  );

  const getOrCreatePeer = useCallback(
    (remoteId: string, channel: RealtimeChannel): AnySpeakPeer => {
      const existing = peersRef.current.get(remoteId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 4,
      });

      const remoteStream = new MediaStream();

      pc.oniceconnectionstatechange = () => {
        log(`ice(${remoteId}) state: ${pc.iceConnectionState}`);
      };

      pc.onicegatheringstatechange = () => {
        log(`iceGather(${remoteId}) state: ${pc.iceGatheringState}`);
      };

      pc.onconnectionstatechange = () => {
        log(`pc(${remoteId}) state: ${pc.connectionState}`);

        if (pc.connectionState === "connected") setConnected(true);

        if (
          pc.connectionState === "disconnected" ||
          pc.connectionState === "failed" ||
          pc.connectionState === "closed"
        ) {
          peersRef.current.delete(remoteId);
          setTimeout(() => {
            if (peersRef.current.size === 0) setConnected(false);
          }, 0);
        }
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          channel.send({
            type: "broadcast",
            event: "webrtc",
            payload: {
              type: "ice",
              from: clientId,
              to: remoteId,
              candidate: e.candidate.toJSON(),
            },
          });
        }
      };

      pc.ontrack = (e) => {
        if (e.track?.kind === "audio") {
          e.track.enabled = !shouldMuteRawAudioRef.current;
        }

        if (e.streams && e.streams[0]) {
          e.streams[0].getTracks().forEach((t) => {
            if (!remoteStream.getTracks().find((x) => x.id === t.id)) {
              remoteStream.addTrack(t);
            }
          });
        } else if (e.track) {
          if (!remoteStream.getTracks().find((x) => x.id === e.track.id)) {
            remoteStream.addTrack(e.track);
          }
        }

        upsertPeerStream(remoteId, remoteStream);
        log("ontrack", { from: remoteId, kind: e.track?.kind });
      };

      // Add local tracks (mobile: keep STT-only policy by not sending audio)
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => {
          if (isMobile && t.kind === "audio") return;
          pc.addTrack(t, localStreamRef.current!);
        });
      } else {
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
      }

      const peer: AnySpeakPeer = { pc, remoteStream };
      peersRef.current.set(remoteId, peer);
      return peer;
    },
    [clientId, iceServers, isMobile, localStreamRef, log, peersRef, setConnected, shouldMuteRawAudioRef, upsertPeerStream]
  );

  const makeOffer = useCallback(
    async (toId: string, channel: RealtimeChannel) => {
      const { pc } = getOrCreatePeer(toId, channel);

      // Ensure the local video track is present before creating the offer.
      // Prevents SDP omitting video due to camera startup race.
      await waitForLocalVideoTrack();

      if (localStreamRef.current) {
        const haveKinds = new Set(
          pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
        );

        localStreamRef.current.getTracks().forEach((t) => {
          if (isMobile && t.kind === "audio") return;
          if (!haveKinds.has(t.kind)) pc.addTrack(t, localStreamRef.current!);
        });
      }

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      await pc.setLocalDescription(offer);

      channel.send({
        type: "broadcast",
        event: "webrtc",
        payload: { type: "offer", from: clientId, to: toId, sdp: offer },
      });

      log("sent offer", { to: toId });
    },
    [clientId, getOrCreatePeer, isMobile, localStreamRef, log, waitForLocalVideoTrack]
  );

  const handleOffer = useCallback(
    async (fromId: string, sdp: RTCSessionDescriptionInit, channel: RealtimeChannel) => {
      const { pc } = getOrCreatePeer(fromId, channel);

      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushIce(fromId);

      // Ensure the local video track is present before creating the answer.
      // Prevents SDP omitting video due to camera startup race.
      await waitForLocalVideoTrack();

      if (localStreamRef.current) {
        const haveKinds = new Set(
          pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
        );

        localStreamRef.current.getTracks().forEach((t) => {
          if (isMobile && t.kind === "audio") return;
          if (!haveKinds.has(t.kind)) pc.addTrack(t, localStreamRef.current!);
        });
      }

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      channel.send({
        type: "broadcast",
        event: "webrtc",
        payload: { type: "answer", from: clientId, to: fromId, sdp: answer },
      });

      log("sent answer", { to: fromId });
    },
    [clientId, flushIce, getOrCreatePeer, isMobile, localStreamRef, log, waitForLocalVideoTrack]
  );

  const handleAnswer = useCallback(
    async (fromId: string, sdp: RTCSessionDescriptionInit) => {
      const peer = peersRef.current.get(fromId);
      if (!peer) return;
      await peer.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await flushIce(fromId);
      log("applied answer", { from: fromId });
    },
    [flushIce, log, peersRef]
  );

  const handleIce = useCallback(
    async (fromId: string, candidate: RTCIceCandidateInit) => {
      const peer = peersRef.current.get(fromId);

      // If ICE arrives before we have SDP applied, queue it.
      if (!peer) {
        enqueueIce(fromId, candidate);
        log("queued ice (no peer yet)", { from: fromId });
        return;
      }

      if (!peer.pc.remoteDescription) {
        enqueueIce(fromId, candidate);
        log("queued ice (no remoteDescription yet)", { from: fromId });
        return;
      }

      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        log("added ice", { from: fromId });
      } catch (err) {
        log("ice error", { err: (err as Error).message });
      }
    },
    [enqueueIce, log, peersRef]
  );

  return {
    clearPendingIce,
    getOrCreatePeer,
    makeOffer,
    handleOffer,
    handleAnswer,
    handleIce,
  };
}
