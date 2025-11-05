"use client";

import { useCallback, useState } from "react";
import { translateText } from "@/lib/translate";
import type { LanguageCode } from "@/lib/translation";

export type TranslationMessage = {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  original: string;
  translated: string;
  from: LanguageCode | string;
  to: LanguageCode | string;
  ts: number;
};

/**
 * Local translation/captions hook.
 * - Keeps a list of caption messages.
 * - Translates text client-side via lib/translate (Supabase Edge Function).
 * - Optionally TTS the translated text if provided.
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
      // Call the Edge Function (or no-op passthrough if not configured)
      let translated = text;
      try {
        translated = await translateText(text, String(fromLang), String(toLang));
      } catch (e) {
        console.warn("[useTranslation] translateText failed, using original text", e);
      }

      const msg: TranslationMessage = {
        id: crypto.randomUUID(),
        roomId,
        senderId: myPeerId,
        senderName: myName,
        original: text,
        translated,
        from: fromLang,
        to: toLang,
        ts: Date.now(),
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
