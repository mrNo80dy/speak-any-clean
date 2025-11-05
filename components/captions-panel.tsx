"use client"

import { useEffect, useRef } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import type { TranslationMessage } from "@/hooks/use-translation"

interface CaptionsPanelProps {
  messages: TranslationMessage[]
}

export function CaptionsPanel({ messages }: CaptionsPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        Captions will appear here when speech is detected
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div ref={scrollRef} className="space-y-3 p-4">
        {messages.map((message) => (
          <div key={message.id} className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>{message.peerId ? `Peer ${message.peerId.slice(0, 6)}` : "You"}</span>
              <span>•</span>
              <span>{message.fromLanguage.toUpperCase()}</span>
            </div>
            <div className="bg-gray-800 rounded-lg p-3 space-y-2">
              <p className="text-sm text-gray-300">{message.originalText}</p>
              {message.originalText !== message.translatedText && (
                <>
                  <div className="border-t border-gray-700" />
                  <div className="flex items-center gap-2 text-xs text-indigo-400">
                    <span>{message.toLanguage.toUpperCase()}</span>
                  </div>
                  <p className="text-sm text-white font-medium">{message.translatedText}</p>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  )
}
