"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

export type RealtimeSubscribeStatus =
  | "SUBSCRIBED"
  | "CLOSED"
  | "TIMED_OUT"
  | "CHANNEL_ERROR";

type AnySpeakRealtimeArgs = {
  roomId: string | undefined;
  clientId: string;
  debugKey: string;
  prejoinDone: boolean;
  roomType: "audio" | "video" | null;
  joinCamOn: boolean | null;

  displayNameRef: React.MutableRefObject<string>;

  /** Optional logger compatible with your RoomPage log() helper. */
  log?: (msg: string, data?: any) => void;

  /** Runs BEFORE we create the Supabase channel (media acquire / cam enforcement lives here). */
  beforeConnect?: () => Promise<void> | void;

  /** Called for each incoming broadcast message of the given event. */
  onWebrtc?: (message: any, channel: RealtimeChannel) => Promise<void> | void;
  onTranscript?: (message: any, channel: RealtimeChannel) => Promise<void> | void;
  onHand?: (message: any, channel: RealtimeChannel) => Promise<void> | void;

  /** Called when presence sync runs; you compute others/labels and do your auto-mute/offer logic. */
  onPresenceSync?: (channel: RealtimeChannel) => void;

  /** Called on cleanup so RoomPage can teardown peers, stop media, etc. */
  onCleanup?: () => void;
};

/**
 * Hook #2: Realtime lifecycle (stable channel + rebuild-on-failure)
 *
 * This is intentionally a "behavior-preserving extraction":
 * - same channel name
 * - same subscribe/rebuild behavior
 * - same event wiring
 */
export function useAnySpeakRealtime(args: AnySpeakRealtimeArgs) {
  const {
    roomId,
    clientId,
    debugKey,
    prejoinDone,
    roomType,
    joinCamOn,
    log,
    beforeConnect,
    onWebrtc,
    onTranscript,
    onHand,
    onPresenceSync,
    onCleanup,
  } = args;

  const channelRef = useRef<RealtimeChannel | null>(null);
  const lastRtStatusRef = useRef<string>("INIT");

  const rebuildTimerRef = useRef<number | null>(null);
  const rebuildScheduledRef = useRef(false);
  const [rtNonce, setRtNonce] = useState(0);
  const [rtStatus, setRtStatus] = useState<RealtimeSubscribeStatus | "INIT">("INIT");

  const depsKey = useMemo(
    () => `${roomId || ""}|${clientId}|${debugKey}|${rtNonce}|${prejoinDone}|${roomType || ""}|${joinCamOn === null ? "null" : joinCamOn}`,
    [roomId, clientId, debugKey, rtNonce, prejoinDone, roomType, joinCamOn]
  );

  useEffect(() => {
    if (!roomId || !clientId) return;
    if (!prejoinDone) return;
    if (!roomType) return;

    let alive = true;

    const scheduleRebuildOnce = (why: any) => {
      if (rebuildScheduledRef.current) return;
      rebuildScheduledRef.current = true;
      log?.("realtime died; scheduling rebuild", why);

      rebuildTimerRef.current = window.setTimeout(() => {
        rebuildScheduledRef.current = false;
        setRtNonce((n) => n + 1);
      }, 500);
    };

    (async () => {
      try {
        // Keep the same order as the old RoomPage effect.
        await beforeConnect?.();

        const channel = supabase.channel(`room:${roomId}`, {
          config: {
            broadcast: { self: false },
            presence: { key: clientId },
          },
        });

        channelRef.current = channel;

        if (onWebrtc) {
          channel.on("broadcast", { event: "webrtc" }, async (message: any) => {
            await onWebrtc(message, channel);
          });
        }

        if (onTranscript) {
          channel.on("broadcast", { event: "transcript" }, async (message: any) => {
            await onTranscript(message, channel);
          });
        }

        if (onHand) {
          channel.on("broadcast", { event: "hand" }, async (message: any) => {
            await onHand(message, channel);
          });
        }

        if (onPresenceSync) {
          channel.on("presence", { event: "sync" }, () => {
            onPresenceSync(channel);
          });
        }

        channel.subscribe((status: RealtimeSubscribeStatus) => {
          if (!alive) return;

          if (lastRtStatusRef.current !== status) {
            lastRtStatusRef.current = status;
            log?.("realtime status", { status });
          }

          setRtStatus(status);

          if (status === "SUBSCRIBED") {
            try {
              channel.track({ clientId });
            } catch {}
            return;
          }

          if (status === "CLOSED" || status === "TIMED_OUT" || status === "CHANNEL_ERROR") {
            scheduleRebuildOnce({ status });
          }
        });
      } catch (err: any) {
        log?.("init error", { err: err?.message || String(err) });
      }
    })();

    return () => {
      alive = false;

      if (rebuildTimerRef.current) {
        clearTimeout(rebuildTimerRef.current);
        rebuildTimerRef.current = null;
      }
      rebuildScheduledRef.current = false;

      try {
        const ch = channelRef.current;
        if (ch) {
          ch.untrack();
          ch.unsubscribe();
        }
      } catch {}
      channelRef.current = null;

      try {
        onCleanup?.();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return { rtStatus, channelRef };
}
