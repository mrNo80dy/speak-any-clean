"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import type { LanguageCode } from "@/lib/translation"

export function useTextToSpeech() {
  const [speaking, setSpeaking] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)

  useEffect(() => {
    if (typeof window === "undefined") return

    const loadVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices()
      setVoices(availableVoices)
    }

    loadVoices()
    window.speechSynthesis.onvoiceschanged = loadVoices

    return () => {
      window.speechSynthesis.cancel()
    }
  }, [])

  const speak = useCallback(
    (text: string, language: LanguageCode) => {
      if (!enabled || !text.trim()) return

      // Cancel any ongoing speech
      window.speechSynthesis.cancel()

      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = language
      utterance.rate = 1.0
      utterance.pitch = 1.0

      // Try to find a voice for the target language
      const voice = voices.find((v) => v.lang.startsWith(language))
      if (voice) {
        utterance.voice = voice
      }

      utterance.onstart = () => setSpeaking(true)
      utterance.onend = () => setSpeaking(false)
      utterance.onerror = () => setSpeaking(false)

      utteranceRef.current = utterance
      window.speechSynthesis.speak(utterance)
    },
    [enabled, voices],
  )

  const stop = useCallback(() => {
    window.speechSynthesis.cancel()
    setSpeaking(false)
  }, [])

  const toggleEnabled = useCallback(() => {
    setEnabled((prev) => !prev)
    if (enabled) {
      stop()
    }
  }, [enabled, stop])

  return {
    speak,
    stop,
    speaking,
    enabled,
    toggleEnabled,
    voices,
  }
}
