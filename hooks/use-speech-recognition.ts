"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import type { LanguageCode } from "@/lib/translation"

export function useSpeechRecognition(language: LanguageCode, enabled: boolean) {
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState("")
  const [interimTranscript, setInterimTranscript] = useState("")
  const recognitionRef = useRef<any>(null)
  const finalTranscriptRef = useRef("")

  useEffect(() => {
    if (typeof window === "undefined") return

    // Check if browser supports speech recognition
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition

    if (!SpeechRecognition) {
      console.warn("[v0] Speech recognition not supported in this browser")
      return
    }

    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = language
    recognition.maxAlternatives = 1

    recognition.onstart = () => {
      console.log("[v0] Speech recognition started")
      setIsListening(true)
    }

    recognition.onend = () => {
      console.log("[v0] Speech recognition ended")
      setIsListening(false)

      // Restart if still enabled
      if (enabled) {
        try {
          recognition.start()
        } catch (error) {
          console.error("[v0] Failed to restart recognition:", error)
        }
      }
    }

    recognition.onerror = (event: any) => {
      console.error("[v0] Speech recognition error:", event.error)
      if (event.error === "no-speech") {
        // Ignore no-speech errors, they're normal
        return
      }
      setIsListening(false)
    }

    recognition.onresult = (event: any) => {
      let interim = ""
      let final = ""

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript
        if (event.results[i].isFinal) {
          final += transcript + " "
        } else {
          interim += transcript
        }
      }

      if (final) {
        finalTranscriptRef.current += final
        setTranscript(finalTranscriptRef.current)
        setInterimTranscript("")
      } else {
        setInterimTranscript(interim)
      }
    }

    recognitionRef.current = recognition

    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
    }
  }, [language])

  useEffect(() => {
    if (!recognitionRef.current) return

    if (enabled && !isListening) {
      try {
        recognitionRef.current.start()
      } catch (error) {
        console.error("[v0] Failed to start recognition:", error)
      }
    } else if (!enabled && isListening) {
      recognitionRef.current.stop()
    }
  }, [enabled, isListening])

  const clearTranscript = useCallback(() => {
    setTranscript("")
    setInterimTranscript("")
    finalTranscriptRef.current = ""
  }, [])

  return {
    isListening,
    transcript,
    interimTranscript,
    clearTranscript,
  }
}
