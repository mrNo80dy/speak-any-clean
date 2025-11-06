"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { supabase } from "@/lib/supabaseClient";
import RoomCall from "@/components/RoomCall";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Room = {
  id: string;
  name: string | null;
  code: string | null;
  is_active: boolean;
  created_at?: string | null;
};

export default function RoomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const roomId = useMemo(() => (Array.isArray(params?.id) ? params.id[0] : params?.id) ?? "", [params]);

  const [loading, setLoading] = useState(true);
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetch room by ID on mount/when id changes
  useEffect(() => {
    if (!roomId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error } = await supabase
          .from("rooms")
          .select("id,name,code,is_active,created_at")
          .eq("id", roomId)
          .maybeSingle();

        console.log("[RoomPage] fetch by id", { roomId, data, error });

        if (cancelled) return;

        if (error) {
          setError(error.message);
          setRoom(null);
        } else if (!data) {
          // Not found
          setRoom(null);
        } else {
          setRoom(data as Room);
        }
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message ?? "Unknown error");
          setRoom(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Loading room…</CardTitle>
            <CardDescription>Fetching room details</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="text-sm text-gray-600">Please wait…</div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Not found / error state
  if (!room) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle>Room Not Found</CardTitle>
            <CardDescription>
              The room you're looking for doesn't exist or has been deleted.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <Button asChild>
              <Link href="/">Back to Home</Link>
            </Button>
            {error ? <div className="text-sm text-red-600">{error}</div> : null}
          </CardContent>
        </Card>
      </div>
    );
  }

  // Happy path: room exists
  return (
    <div className="min-h-screen p-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Room: {room.name ?? "(unnamed)"}</h1>
            <p className="text-sm text-gray-600">
              <span className="font-semibold">ID:</span> {room.id} &nbsp;•&nbsp;{" "}
              <span className="font-semibold">Code:</span> {room.code ?? "(none)"} &nbsp;•&nbsp;{" "}
              <span className="font-semibold">Active:</span> {String(room.is_active)}
            </p>
          </div>
          <Button variant="outline" onClick={() => router.push("/")}>
            Home
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Call</CardTitle>
            <CardDescription>Join the call and start speaking</CardDescription>
          </CardHeader>
          <CardContent>
            {/* Real call UI */}
            <RoomCall roomId={room.id} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
