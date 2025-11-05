"use client";

import { useCallback, useState } from "react";
import { translateText } from "@/lib/translate";
import type { LanguageCode } from "@/lib/translation";

/**
 * Unified shape that satisfies both the new and existing UI components.
 * Includes aliases so components using older field names don't break.
 */
export type TranslationMessage = {
  id: string;
  ts: number;

  // Core identifiers
  roomId: string;
  senderId: string;
  senderName: string;

  // Aliases for older components (e.g., CaptionsPanel)
  peerId?: string; // alias of senderId

  // Text
  original: string;
  translated: string;

  // Aliases for older components (some UIs expect these names)
  text?: string;            // alias of original
  translatedText?: string;  // alias of translated

  // Languages
  from: LanguageCode | string;
  to: LanguageCode | string;

  // Aliases for older components
  fromLanguage?: string; // alias of from
  toLanguage?: string;   // alias of to
};

/**
 * Local translation/captions hook.
 * - Keeps a list of caption messages.
 * - Translates text through lib/translate (Supabase Edge Function, or passthrough).
 * - Optionally speaks the translated text via injected TTS.
 */
export function useTranslation(
  roomId: string,
  myPeerId: string,
  myName: string,
  myLanguage: LanguageCode,
  ttsEnabled?: boolean,
  speak?: (text: string, lang: string) => void
) {
  const [messages, setMessages] = useState<TranslationMessage[]>([]);

  const addTranslation = useCallback(
    async (text: string, fromLang: LanguageCode | string, toLang: LanguageCode | string) => {
      // Try translation; fall back to original if function is not configured
      let translated = text;
      try {
        translated = await translateText(text, String(fromLang), String(toLang));
      } catch (e) {
        console.warn("[useTranslation] translateText failed, using original text", e);
      }

      const msg: TranslationMessage = {
        id: crypto.randomUUID(),
        ts: Date.now(),

        // ids / names
        roomId,
        senderId: myPeerId,
        senderName: myName,
        peerId: myPeerId, // alias for components expecting peerId

        // text (with aliases)
        original: text,
        translated,
        text,                 // alias
        translatedText: translated, // alias

        // languages (with aliases)
        from: fromLang,
        to: toLang,
        fromLanguage: String(fromLang),
        toLanguage: String(toLang),
      };

      setMessages((prev) => [...prev, msg]);

      if (ttsEnabled && speak && translated) {
        try {
          speak(translated, String(toLang));
        } catch (e) {
          console.warn("[useTranslation] speak() failed", e);
        }
      }

      return msg;
    },
    [roomId, myPeerId, myName, ttsEnabled, speak]
  );

  return { messages, addTranslation };
}
