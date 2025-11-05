"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useRoom } from "@/hooks/use-room";
import { useWebRTC } from "@/hooks/use-webrtc-hook";
import { useSpeechRecognition } from "@/hooks/use-speech-recognition";
import { useTranslation } from "@/hooks/use-translation";
import { useTextToSpeech } from "@/hooks/use-text-to-speech";
import { VideoGrid } from "@/components/video-grid";
import { ControlBar } from "@/components/control-bar";
import { CaptionsPanel } from "@/components/captions-panel";
import { LanguageSelector } from "@/components/language-selector";
import type { LanguageCode } from "@/lib/translation";
import { ArrowLeft, Copy, Check, Settings } from "lucide-react";

interface RoomViewProps {
  roomId: string;
}

export function RoomView({ roomId }: RoomViewProps) {
  const router = useRouter();
  const { room, participants, loading, error, joinRoom, leaveRoom } = useRoom(roomId);

  const [copied, setCopied] = useState(false);
  const [myPeerId] = useState(() => crypto.randomUUID());
  const [joined, setJoined] = useState(false);
  const [myLanguage, setMyLanguage] = useState<LanguageCode>("en");
  const [targetLanguage, setTargetLanguage] = useState<LanguageCode>("es");
  const [captionsVisible, setCaptionsVisible] = useState(true);
  const [settingsVisible, setSettingsVisible] = useState(false);

  // 1) Hooks that define values used elsewhere should come first.
  const { enabled: ttsEnabled, speak, toggleEnabled: toggleTTS } = useTextToSpeech();

  // 2) WebRTC after we know if we’re joined
  const { localStream, peerConnections, audioEnabled, videoEnabled, toggleAudio, toggleVideo } =
    useWebRTC(joined ? roomId : null, joined ? myPeerId : null, participants);

  // 3) Translation bus (no TTS passed in here — we trigger TTS in our effect below)
  const { messages, addTranslation } = useTranslation();

  // 4) Speech recognition depends on audioEnabled and join state
  const { transcript, interimTranscript, clearTranscript } = useSpeechRecognition(
    myLanguage,
    audioEnabled && joined
  );

  // Join once room is loaded
  useEffect(() => {
    if (room && !joined) {
      joinRoom(myPeerId, myLanguage);
      setJoined(true);
    }
  }, [room, joined, joinRoom, myPeerId, myLanguage]);

  // Leave on unmount
  useEffect(() => {
    return () => {
      if (joined) leaveRoom(myPeerId);
    };
  }, [joined, leaveRoom, myPeerId]);

  // When we get a final transcript, translate it and optionally speak it
  useEffect(() => {
    if (!transcript) return;
    (async () => {
      const message = await addTranslation(transcript, myLanguage, targetLanguage);
      if (message && ttsEnabled) {
        // The device that *needs* the translation should hear it.
        // If you only want remote to hear it, gate this with a role/flag later.
        speak(message.translatedText, targetLanguage);
      }
      clearTranscript();
    })();
  }, [transcript, myLanguage, targetLanguage, addTranslation, ttsEnabled, speak, clearTranscript]);

  const copyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLeave = () => {
    leaveRoom(myPeerId);
    router.push("/");
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading room...</p>
        </div>
      </div>
    );
  }

  if (error || !room) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="text-red-600">Room Not Found</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-gray-600">The room you're looking for doesn't exist or has been deleted.</p>
            <Button onClick={() => router.push("/")} className="w-full">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back to Home
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      {/* Header */}
      <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div>
              <h1 className="text-lg font-semibold text-white">{room.name}</h1>
              <div className="flex items-center gap-2 text-sm text-gray-400">
                <span className="font-mono">{roomId.slice(0, 8)}...</span>
                <button onClick={copyRoomId} className="hover:text-white transition-colors">
                  {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                </button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-sm text-gray-400">
              {participants.length} participant{participants.length !== 1 ? "s" : ""}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSettingsVisible(!settingsVisible)}
              className="text-gray-300 hover:text-white"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Settings Panel */}
      {settingsVisible && (
        <div className="bg-gray-800 border-b border-gray-700 px-4 py-4">
          <div className="max-w-7xl mx-auto grid md:grid-cols-2 gap-4">
            <LanguageSelector value={myLanguage} onChange={setMyLanguage} label="I speak" />
            <LanguageSelector value={targetLanguage} onChange={setTargetLanguage} label="Translate to" />
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Video Grid */}
        <div className={`flex-1 ${captionsVisible ? "md:w-2/3" : "w-full"}`}>
          <VideoGrid
            localStream={localStream}
            peerConnections={peerConnections}
            audioEnabled={audioEnabled}
            videoEnabled={videoEnabled}
          />
          {/* Interim transcript overlay */}
          {interimTranscript && (
            <div className="absolute bottom-24 left-1/2 -translate-x-1/2 bg-black/80 text-white px-4 py-2 rounded-lg text-sm">
              {interimTranscript}
            </div>
          )}
        </div>

        {/* Captions Panel */}
        {captionsVisible && (
          <div className="w-full md:w-1/3 bg-gray-800 border-l border-gray-700">
            <div className="h-full flex flex-col">
              <div className="px-4 py-3 border-b border-gray-700">
                <h2 className="text-sm font-semibold text-white">Live Captions</h2>
              </div>
              <div className="flex-1 overflow-hidden">
                <CaptionsPanel messages={messages} />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Control Bar */}
      <ControlBar
        audioEnabled={audioEnabled}
        videoEnabled={videoEnabled}
        ttsEnabled={ttsEnabled}
        captionsVisible={captionsVisible}
        onToggleAudio={toggleAudio}
        onToggleVideo={toggleVideo}
        onToggleTTS={toggleTTS}
        onToggleCaptions={() => setCaptionsVisible(!captionsVisible)}
        onLeave={handleLeave}
      />
    </div>
  );
}
