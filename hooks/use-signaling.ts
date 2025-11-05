"use client"

import { useEffect, useCallback, useRef } from "react"
import { getSupabase } from "@/lib/supabase"

export type SignalData = {
  type: "offer" | "answer" | "ice-candidate"
  data: any
}

export function useSignaling(
  roomId: string | null,
  peerId: string | null,
  onSignal: (fromPeer: string, signal: SignalData) => void,
) {
  const channelRef = useRef<any>(null)

  useEffect(() => {
    if (!roomId || !peerId) return

    const supabase = getSupabase()

    // Subscribe to signaling messages for this peer
    const channel = supabase
      .channel(`signaling:${roomId}:${peerId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "signaling",
          filter: `room_id=eq.${roomId}`,
        },
        async (payload: any) => {
          const signal = payload.new
          if (signal.to_peer === peerId) {
            console.log("[v0] Received signal:", signal.signal_type, "from", signal.from_peer)
            onSignal(signal.from_peer, {
              type: signal.signal_type,
              data: signal.signal_data,
            })

            // Delete the signal after processing
            await supabase.from("signaling").delete().eq("id", signal.id)
          }
        },
      )
      .subscribe()

    channelRef.current = channel

    return () => {
      channel.unsubscribe()
    }
  }, [roomId, peerId, onSignal])

  const sendSignal = useCallback(
    async (toPeer: string, signal: SignalData) => {
      if (!roomId || !peerId) return

      const supabase = getSupabase()
      await supabase.from("signaling").insert({
        room_id: roomId,
        from_peer: peerId,
        to_peer: toPeer,
        signal_type: signal.type,
        signal_data: signal.data,
      })

      console.log("[v0] Sent signal:", signal.type, "to", toPeer)
    },
    [roomId, peerId],
  )

  return { sendSignal }
}
