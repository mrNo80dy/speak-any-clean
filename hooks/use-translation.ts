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

  // aliases expected by CaptionsPanel
  peerId: string;

  // text (canonical)
  original: string;
  translated: string;

  // aliases used by components
  text: string;             // alias of original
  originalText: string;     // alias of original
  translatedText: string;   // alias of translated

  // languages (canonical)
  from: LanguageCode;
  to: LanguageCode;

  // aliases expected by components
  fromLanguage: LanguageCode;
  toLanguage: LanguageCode;
};

export function useTranslation(
  roomId: string,
  myPeerId: string,
  myName: string,
  myLanguage: LanguageCode,
  ttsEnabled?: boolean,
  speak?: (text: string, language: LanguageCode) => void
) {
  const [messages, setMessages] = useState<TranslationMessage[]>([]);

  const addTranslation = useCallback(
    async (text: string, fromLang: LanguageCode, toLang: LanguageCode) => {
      let translated = text;
      try {
        // translateText accepts strings; LanguageCode is a string union, so it’s fine
        translated = await translateText(text, fromLang, toLang);
      } catch (e) {
        console.warn("[useTranslation] translateText failed, using original text", e);
      }

      const msg: TranslationMessage = {
        id: crypto.randomUUID(),
        ts: Date.now(),

        roomId,
        senderId: myPeerId,
        senderName: myName,
        peerId: myPeerId,

        original: text,
        translated,
        text,
        originalText: text,
        translatedText: translated,

        from: fromLang,
        to: toLang,
        fromLanguage: fromLang,
        toLanguage: toLang,
      };

      setMessages((prev) => [...prev, msg]);

      if (ttsEnabled && speak && translated) {
        try {
          speak(translated, toLang); // now correctly typed
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
