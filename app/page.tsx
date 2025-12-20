"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Video, Globe, Mic } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

type RoomType = "audio" | "video";

export default function HomePage() {
  const router = useRouter();

  const [roomName, setRoomName] = useState("");
  const [roomIdOrCode, setRoomIdOrCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [displayName, setDisplayName] = useState("");

  // ✅ Creator chooses the room type
  const [roomType, setRoomType] = useState<RoomType>("audio");

  // Load saved display name once (shared between create/join, PC/phone)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const saved = localStorage.getItem("displayName");
    if (saved) setDisplayName(saved);
  }, []);

  const generateRoomCode = () =>
    Math.random().toString(36).slice(2, 8).toUpperCase();

  const saveDisplayName = () => {
    const nameToSave = displayName.trim() || "Guest";
    if (typeof window !== "undefined") {
      localStorage.setItem("displayName", nameToSave);
    }
    return nameToSave;
  };

  const handleCreateRoom = async () => {
    const name = roomName.trim();
    if (!name) return;

    setCreating(true);
    try {
      console.log("[CreateRoom] start", { name, roomType });

      const code = generateRoomCode();
      saveDisplayName();

      // ✅ Creator-enforced room_type saved in DB
      const { data, error } = await supabase
        .from("rooms")
        .insert({
          name,
          code,
          is_active: true,
          room_type: roomType, // ✅ NEW
        })
        .select("id, code, room_type")
        .single();

      console.log("[CreateRoom] result", { data, error });

      if (error) {
        alert(`Create failed: ${error.message}`);
        return;
      }
      if (!data?.id || !data?.code) {
        alert("Create failed: no id/code returned from database");
        return;
      }

      router.push(`/room/${data.id}`);
    } catch (e: any) {
      console.error("[CreateRoom] unexpected error", e);
      alert(`Unexpected error creating room: ${e?.message ?? e}`);
    } finally {
      setCreating(false);
    }
  };

  const handleJoinRoom = async () => {
    const value = roomIdOrCode.trim();
    if (!value) return;

    setJoining(true);
    try {
      console.log("[JoinRoom] value", value);

      saveDisplayName();

      const looksLikeUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value
        );

      if (looksLikeUUID) {
        router.push(`/room/${value}`);
        return;
      }

      const { data: room, error } = await supabase
        .from("rooms")
        .select("id")
        .eq("code", value.toUpperCase())
        .eq("is_active", true)
        .maybeSingle();

      console.log("[JoinRoom] result", { room, error });

      if (error) {
        alert(`Lookup failed: ${error.message}`);
        return;
      }
      if (!room?.id) {
        alert("Room not found. Check the ID/code and try again.");
        return;
      }

      router.push(`/room/${room.id}`);
    } catch (e: any) {
      console.error("[JoinRoom] unexpected error", e);
      alert(`Unexpected error joining room: ${e?.message ?? e}`);
    } finally {
      setJoining(false);
    }
  };

  const onCreateKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleCreateRoom();
  };
  const onJoinKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleJoinRoom();
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 p-4">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="p-3 bg-indigo-600 rounded-xl">
              <Video className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900">Any-Speak</h1>
          </div>
          <p className="text-lg text-gray-600">
            Real-time calls with live translation (audio or video)
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Create Room */}
          <Card>
            <CardHeader>
              <CardTitle>Create Room</CardTitle>
              <CardDescription>
                The creator chooses Audio or Video. Joiners follow the room type.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="display-name-create">Your Name</Label>
                <Input
                  id="display-name-create"
                  placeholder="How you appear in the room"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="room-name">Room Name</Label>
                <Input
                  id="room-name"
                  placeholder="My Translation Room"
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  onKeyDown={onCreateKey}
                />
              </div>

              {/* ✅ Room type picker */}
              <div className="space-y-2">
                <Label>Room Type</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRoomType("audio")}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                      roomType === "audio"
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white text-gray-900 border-gray-300"
                    }`}
                  >
                    <Mic className="w-4 h-4" />
                    Audio
                  </button>

                  <button
                    type="button"
                    onClick={() => setRoomType("video")}
                    className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm ${
                      roomType === "video"
                        ? "bg-indigo-600 text-white border-indigo-600"
                        : "bg-white text-gray-900 border-gray-300"
                    }`}
                  >
                    <Video className="w-4 h-4" />
                    Video
                  </button>
                </div>
                <div className="text-xs text-gray-600">
                  Billing/minutes can differ by type later — this locks the room’s type now.
                </div>
              </div>

              <Button
                onClick={handleCreateRoom}
                disabled={creating || !roomName.trim()}
                className="w-full"
              >
                {creating
                  ? "Creating..."
                  : roomType === "video"
                    ? "Create Video Room"
                    : "Create Audio Room"}
              </Button>
            </CardContent>
          </Card>

          {/* Join Room */}
          <Card>
            <CardHeader>
              <CardTitle>Join Room</CardTitle>
              <CardDescription>
                Enter a Room ID (UUID) or Room Code. Room type is enforced by the creator.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="display-name-join">Your Name</Label>
                <Input
                  id="display-name-join"
                  placeholder="How you appear in the room"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="room-id">Room ID or Code</Label>
                <Input
                  id="room-id"
                  placeholder="Paste the room ID or enter the 6-char code"
                  value={roomIdOrCode}
                  onChange={(e) => setRoomIdOrCode(e.target.value)}
                  onKeyDown={onJoinKey}
                />
              </div>
              <Button
                onClick={handleJoinRoom}
                disabled={joining || !roomIdOrCode.trim()}
                variant="outline"
                className="w-full bg-transparent"
              >
                {joining ? "Joining..." : "Join Room"}
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="mt-8 p-6 bg-white rounded-lg shadow-sm">
          <div className="flex items-start gap-3">
            <Globe className="w-5 h-5 text-indigo-600 mt-0.5" />
            <div>
              <h3 className="font-semibold text-gray-900 mb-2">How it works</h3>
              <ul className="text-sm text-gray-600 space-y-1">
                <li>• Create an Audio or Video room (creator sets the type)</li>
                <li>• Join with the Room ID or 6-character code</li>
                <li>• Speak naturally — captions translate in real-time</li>
                <li>• Optionally hear translated speech (if enabled)</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
