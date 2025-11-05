"use client"

import { Button } from "@/components/ui/button"
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  PhoneOff,
  Volume2,
  VolumeX,
  MessageSquare,
} from "lucide-react"

interface ControlBarProps {
  audioEnabled: boolean
  videoEnabled: boolean
  ttsEnabled: boolean
  captionsVisible: boolean
  onToggleAudio: () => void
  onToggleVideo: () => void
  onToggleTTS: () => void
  onToggleCaptions: () => void
  onLeave: () => void
}

export function ControlBar({
  audioEnabled,
  videoEnabled,
  ttsEnabled,
  captionsVisible,
  onToggleAudio,
  onToggleVideo,
  onToggleTTS,
  onToggleCaptions,
  onLeave,
}: ControlBarProps) {
  return (
    // 👇 Changed this container
    <div className="sticky bottom-0 w-full bg-gray-900 border-t border-gray-800 z-30">
      <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-center gap-4">
        <Button
          variant="outline"
          size="lg"
          onClick={onToggleAudio}
          className={`rounded-full w-14 h-14 ${
            audioEnabled
              ? "bg-gray-700 hover:bg-gray-600 text-white border-gray-600"
              : "bg-red-500 hover:bg-red-600 text-white border-red-500"
          }`}
        >
          {audioEnabled ? (
            <Mic className="w-5 h-5" />
          ) : (
            <MicOff className="w-5 h-5" />
          )}
        </Button>

        <Button
          variant="outline"
          size="lg"
          onClick={onToggleVideo}
          className={`rounded-full w-14 h-14 ${
            videoEnabled
              ? "bg-gray-700 hover:bg-gray-600 text-white border-gray-600"
              : "bg-red-500 hover:bg-red-600 text-white border-red-500"
          }`}
        >
          {videoEnabled ? (
            <Video className="w-5 h-5" />
          ) : (
            <VideoOff className="w-5 h-5" />
          )}
        </Button>

        <Button
          variant="outline"
          size="lg"
          onClick={onToggleTTS}
          className={`rounded-full w-14 h-14 ${
            ttsEnabled
              ? "bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-600"
              : "bg-gray-700 hover:bg-gray-600 text-white border-gray-600"
          }`}
          title="Toggle Text-to-Speech"
        >
          {ttsEnabled ? (
            <Volume2 className="w-5 h-5" />
          ) : (
            <VolumeX className="w-5 h-5" />
          )}
        </Button>

        <Button
          variant="outline"
          size="lg"
          onClick={onToggleCaptions}
          className={`rounded-full w-14 h-14 ${
            captionsVisible
              ? "bg-indigo-600 hover:bg-indigo-700 text-white border-indigo-600"
              : "bg-gray-700 hover:bg-gray-600 text-white border-gray-600"
          }`}
          title="Toggle Captions"
        >
          <MessageSquare className="w-5 h-5" />
        </Button>

        <Button
          variant="outline"
          size="lg"
          onClick={onLeave}
          className="rounded-full w-14 h-14 bg-red-500 hover:bg-red-600 text-white border-red-500"
        >
          <PhoneOff className="w-5 h-5" />
        </Button>
      </div>
    </div>
  )
}
