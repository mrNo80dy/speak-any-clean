"use client";

import { useCallback, useState } from "react";
import { translateText } from "@/lib/translate";
import type { LanguageCode } from "@/lib/translation";

export type TranslationMessage = {
  id: string;
  ts: number;

  // ids / names
  roomId: string;
  senderId: string;
  senderName: string;

  // ✅ Aliases expected by CaptionsPanel (now REQUIRED)
  peerId: string;

  // text (canonical)
  original: string;
  translated: string;

  // ✅ Aliases expected by various components (now REQUIRED)
  text: string;            // alias of original
  originalText: string;    // alias of original
  translatedText: string;  // alias of translated

  // languages (canonical)
  from: LanguageCode | string;
  to: LanguageCode | string;

  // ✅ Aliases expected by CaptionsPanel (now REQUIRED)
  fromLanguage: string; // alias of from
  toLanguage: string;   // alias of to
};

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
      let translated = text;
      try {
        translated = await translateText(text, String(fromLang), String(toLang));
      } catch (e) {
        console.warn("[useTranslation] translateText failed, using original text", e);
      }

      const msg: TranslationMessage = {
        id: crypto.randomUUID(),
        ts: Date.now(),

        roomId,
        senderId: myPeerId,
        senderName: myName,
        peerId: myPeerId, // alias required by CaptionsPanel

        original: text,
        translated,
        text,                 // alias
        originalText: text,   // alias required by CaptionsPanel
        translatedText: translated, // alias

        from: fromLang,
        to: toLang,
        fromLanguage: String(fromLang), // required alias
        toLanguage: String(toLang),     // required alias
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
