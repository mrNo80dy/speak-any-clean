"use client";

import { supabase } from "@/lib/supabaseClient";

type Outbound = { type: "broadcast"; event: string; payload: any };

/**
 * Broadcast channel for WebRTC signaling (offer/answer/ice).
 * Queues messages until the channel is SUBSCRIBED.
 */
export function createSignalChannel(roomId: string) {
  const ch = supabase.channel(`signal-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let ready = false;
  const queue: Outbound[] = [];

  const flush = () => {
    if (!ready) return;
    while (queue.length) ch.send(queue.shift()!);
  };

  const safeSend = (msg: Outbound) => {
    if (!ready) queue.push(msg);
    else ch.send(msg);
  };

  ch.subscribe((status) => {
    if (status === "SUBSCRIBED") {
      ready = true;
      flush();
    }
  });

  // expose a send that is queue-aware
  return Object.assign(ch, {
    send: safeSend,
    isReady: () => ready,
  });
}
