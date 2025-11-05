"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Video, Globe } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";

export default function HomePage() {
  const router = useRouter();
  const [roomName, setRoomName] = useState("");
  const [roomIdOrCode, setRoomIdOrCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  const generateRoomCode = () =>
    Math.random().toString(36).slice(2, 8).toUpperCase();

  const handleCreateRoom = async () => {
    const name = roomName.trim();
    if (!name) return;

    setCreating(true);
    try {
      const code = generateRoomCode();
      const { data, error } = await supabase
        .from("rooms")
        .insert({ name, code, is_active: true })
        .select("id, code")
        .single();

      if (error || !data) {
        console.error("create room failed:", error);
        alert("Could not create room. Please try again.");
        return;
      }

      // ✅ Navigate with actual room id
      router.push(`/room/${data.id}`);
    } catch (e) {
      console.error(e);
      alert("Unexpected error creating room.");
    } finally {
      setCreating(false);
    }
  };

  const handleJoinRoom = async () => {
    const value = roomIdOrCode.trim();
    if (!value) return;

    setJoining(true);
    try {
      // If it looks like a UUID, try directly
      const looksLikeUUID =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value
        );

      if (looksLikeUUID) {
        router.push(`/room/${value}`);
        return;
      }

      // Otherwise treat it as a room code
      const { data: room, error } = await supabase
        .from("rooms")
        .select("id")
        .eq("code", value.toUpperCase())
        .eq("is_active", true)
        .maybeSingle();

      if (error || !room) {
        alert("Room not found. Check the ID/code and try again.");
        return;
      }

      router.push(`/room/${room.id}`);
    } catch (e) {
      console.error(e);
      alert("Unexpected error joining room.");
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
            <h1 className="text-4xl font-bold text-gray-900">Speak-any</h1>
          </div>
          <p className="text-lg text-gray-600">Real-time video chat with live translation</p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Create Room</CardTitle>
              <CardDescription>Start a new video chat session</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
              <Button onClick={handleCreateRoom} disabled={creating || !roomName.trim()} className="w-full">
                {creating ? "Creating..." : "Create Room"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Join Room</CardTitle>
              <CardDescription>Enter a Room ID (UUID) or Room Code</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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
                <li>• Create or join a room to start a video call</li>
                <li>• Select your language preference</li>
                <li>• Speak naturally — your words will be translated in real-time</li>
                <li>• See live captions in multiple languages</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
