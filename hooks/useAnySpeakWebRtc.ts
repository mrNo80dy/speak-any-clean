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

  // ---- Perfect negotiation (glare-safe renegotiation)
  // We keep per-peer negotiation flags keyed by remoteId.
  const makingOfferRef = useRef<Map<string, boolean>>(new Map());
  const ignoreOfferRef = useRef<Map<string, boolean>>(new Map());

  const isPolite = useCallback(
    (remoteId: string) => {
      // Deterministic tie-breaker: lower clientId is "polite".
      // Either side can start renegotiation; this prevents offer collisions (glare).
      return clientId.localeCompare(remoteId) < 0;
    },
    [clientId]
  );

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

      // If track changes trigger renegotiation, attempt a glare-safe offer.
      // This complements manual renegotiation (we still expose a function).
      pc.onnegotiationneeded = async () => {
        try {
          // Only negotiate when stable.
          if (pc.signalingState !== "stable") return;
          await negotiate(remoteId, channel, "onnegotiationneeded");
        } catch (err) {
          log("negotiationneeded error", { err: (err as Error).message });
        }
      };

      // Add local tracks (mobile: keep STT-only policy by not sending audio)
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((t) => {
          if (isMobile && t.kind === "audio") return;
          pc.addTrack(t, localStreamRef.current!);
        });

        // Ensure transceivers exist for both kinds so we can upgrade/downgrade mid-call.
        const haveVideo = pc.getTransceivers().some((tr) => tr.receiver?.track?.kind === "video");
        const haveAudio = pc.getTransceivers().some((tr) => tr.receiver?.track?.kind === "audio");
        if (!haveVideo) pc.addTransceiver("video", { direction: "sendrecv" });
        if (!haveAudio) pc.addTransceiver("audio", { direction: isMobile ? "recvonly" : "sendrecv" });
      } else {
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
      }

      const peer: AnySpeakPeer = { pc, remoteStream };
      peersRef.current.set(remoteId, peer);
      return peer;
    },
    // NOTE: negotiate is defined below; useCallback hoisting is ok because function identity is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clientId, iceServers, isMobile, localStreamRef, log, peersRef, setConnected, shouldMuteRawAudioRef, upsertPeerStream]
  );

  const negotiate = useCallback(
    async (toId: string, channel: RealtimeChannel, reason: string) => {
      const { pc } = getOrCreatePeer(toId, channel);

      // Prevent overlapping offers per-peer.
      if (makingOfferRef.current.get(toId)) return;

      // Ensure the local video track is present before creating the offer.
      await waitForLocalVideoTrack();

      // Sync local tracks into the PC before we offer.
      if (localStreamRef.current) {
        const haveKinds = new Set(
          pc.getSenders().map((s) => s.track?.kind).filter(Boolean) as string[]
        );

        localStreamRef.current.getTracks().forEach((t) => {
          if (isMobile && t.kind === "audio") return;
          if (!haveKinds.has(t.kind)) pc.addTrack(t, localStreamRef.current!);
        });
      }

      try {
        makingOfferRef.current.set(toId, true);
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

        log("sent offer", { to: toId, reason });
      } finally {
        makingOfferRef.current.set(toId, false);
      }
    },
    [clientId, getOrCreatePeer, isMobile, localStreamRef, log, waitForLocalVideoTrack]
  );

  const makeOffer = useCallback(
    async (toId: string, channel: RealtimeChannel) => {
      await negotiate(toId, channel, "initial");
    },
    [negotiate]
  );

  const handleOffer = useCallback(
    async (fromId: string, sdp: RTCSessionDescriptionInit, channel: RealtimeChannel) => {
      const { pc } = getOrCreatePeer(fromId, channel);

      const polite = isPolite(fromId);
      const makingOffer = Boolean(makingOfferRef.current.get(fromId));
      const offerCollision = sdp.type === "offer" && (makingOffer || pc.signalingState !== "stable");
      const ignore = !polite && offerCollision;
      ignoreOfferRef.current.set(fromId, ignore);
      if (ignore) {
        log("ignored offer (glare)", { from: fromId });
        return;
      }

      // If we're polite and collided, rollback our local description before applying remote.
      if (offerCollision) {
        try {
          await pc.setLocalDescription({ type: "rollback" });
        } catch {
          // Some browsers may not support rollback in all states; continue best-effort.
        }
      }

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
    [clientId, flushIce, getOrCreatePeer, isMobile, isPolite, localStreamRef, log, waitForLocalVideoTrack]
  );

  const handleAnswer = useCallback(
    async (fromId: string, sdp: RTCSessionDescriptionInit) => {
      const peer = peersRef.current.get(fromId);
      if (!peer) return;
      if (ignoreOfferRef.current.get(fromId)) return;
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
    negotiate,
    handleOffer,
    handleAnswer,
    handleIce,
  };
}
