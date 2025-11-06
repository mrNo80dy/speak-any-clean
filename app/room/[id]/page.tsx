"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";
import { Button } from "@/components/ui/button";

type Room = {
  id: string;
  name: string | null;
  code: string | null;
  is_active: boolean | null;
  created_at: string | null;
};

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const roomId = params?.id;

  const [loading, setLoading] = useState(true);
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!roomId) return;

    (async () => {
      setLoading(true);
      setError(null);

      // Fetch by **id**, not code
      const { data, error } = await supabase
        .from("rooms")
        .select("id, name, code, is_active, created_at")
        .eq("id", roomId)
        .maybeSingle();

      // Debug logs so we can see exactly what's happening
      console.log("[RoomPage] fetch by id", { roomId, data, error });

      if (error) {
        setError(error.message);
        setRoom(null);
      } else {
        setRoom(data);
      }

      setLoading(false);
    })();
  }, [roomId]);

  if (!roomId) {
    return (
      <div className="p-6">
        <p className="text-red-600 font-semibold">No room id in URL.</p>
        <Button className="mt-4" onClick={() => router.push("/")}>
          Back to Home
        </Button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <p className="text-gray-600">Loading room…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <p className="text-red-600 font-semibold">Error: {error}</p>
        <Button className="mt-4" onClick={() => router.push("/")}>
          Back to Home
        </Button>
      </div>
    );
  }

  if (!room) {
    // Only show this if the DB really returned no row
    return (
      <div className="p-6">
        <h2 className="text-xl font-bold mb-2">Room Not Found</h2>
        <p className="text-gray-600 mb-4">
          The room you’re looking for doesn’t exist or is inactive.
        </p>
        <Button onClick={() => router.push("/")}>Back to Home</Button>
      </div>
    );
  }

  // ✅ You have a room row here
  return (
    <div className="p-6 space-y-4">
      <h1 className="text-2xl font-bold">Room: {room.name ?? "(unnamed)"}</h1>
      <div className="text-sm text-gray-600 space-y-1">
        <div><span className="font-semibold">ID:</span> {room.id}</div>
        <div><span className="font-semibold">Code:</span> {room.code ?? "(none)"}</div>
        <div><span className="font-semibold">Active:</span> {String(room.is_active)}</div>
      </div>

      {/* TODO: replace this section with your actual <RoomView/> once this works */}
      <div className="mt-6 p-4 rounded-lg border bg-white">
        <p className="mb-2 text-gray-700">
          Replace this box with your actual room UI once fetching by ID is confirmed.
        </p>
        <Button onClick={() => alert("This is where you'd mount your WebRTC view.")}>
          Start Call (placeholder)
        </Button>
      </div>
    </div>
  );
}
