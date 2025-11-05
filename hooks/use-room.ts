"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

// Keep this file focused on Room CRUD + presence state only.
// No imports from "@/lib/realtime" here to avoid circulars.

type Room = {
  id: string;
  name: string;
  code: string | null;
  is_active: boolean;
  created_at?: string;
};

type ParticipantLite = { id: string };

export function useRoom(roomId: string | null) {
  const [room, setRoom] = useState<Room | null>(null);
  const [participants, setParticipants] = useState<ParticipantLite[]>([]);
  const [loading, setLoading] = useState<boolean>(!!roomId);
  const [error, setError] = useState<string | null>(null);

  // --- create room -----------------------------------------------------------
  const createRoom = useCallback(async (name: string) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();

    const { data, error } = await supabase
      .from("rooms")
      .insert({ name, code, is_active: true })
      .select("id, name, code, is_active, created_at")
      .single();

    if (error || !data) {
      console.error("[useRoom] createRoom error:", error);
      return null;
    }
    // return the newly created row (must include id)
    return data as Room;
  }, []);

  // --- load room (when roomId provided) -------------------------------------
  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("rooms")
        .select("*")
        .eq("id", roomId)
        .maybeSingle();

      if (cancelled) return;
      if (error || !data) {
        console.error("[useRoom] load room error:", error);
        setError("Room not found");
        setRoom(null);
        setLoading(false);
        return;
      }

      setRoom(data as Room);
      setLoading(false);

      // seed participants with me; your WebRTC hook will manage the rest
      setParticipants((prev) => (prev.length ? prev : [{ id: "me" }]));
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // --- join / leave (no-ops for now; your WebRTC hook drives presence) ------
  const joinRoom = useCallback(async (_peerId: string, _lang: string) => {
    // If you later want to write to `participants` table, do it here.
  }, []);

  const leaveRoom = useCallback(async (_peerId: string) => {
    // Cleanup participant entry if you add it in joinRoom().
  }, []);

  return { room, participants, loading, error, createRoom, joinRoom, leaveRoom };
}
