"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { translateText } from "@/lib/translate";

type Msg = {
  id: string;
  speaker: string;
  originalText: string;
  translatedText: string;
  from: string;   // source lang
  to: string;     // target lang (the receiver’s language)
  ts: number;
  senderId: string; // <- who produced/broadcast this message
};

function langCore(v?: string) {
  return (v || "").toLowerCase().split("-")[0]; // en-US -> en
}
export function useTranslation(
  roomId?: string,
  myPeerId?: string,
  myName?: string,
  myLanguage?: string,                                // e.g., "en" or "pt-BR"
  ttsEnabled?: boolean,
  speak?: (text: string, lang: string) => void       // injected from useTextToSpeech
)
export function TranslationMessage(
  // export function useTranslation(
  roomId?: string,
  myPeerId?: string,
  myName?: string,
  myLanguage?: string,                                // e.g., "en" or "pt-BR"
  ttsEnabled?: boolean,
  speak?: (text: string, lang: string) => void       // injected from useTextToSpeech
) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const busRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // subscribe to translation broadcast
  useEffect(() => {
    if (!roomId) return;
    const ch = supabase.channel(`roombus-${roomId}`, { config: { broadcast: { self: false } } });
    busRef.current = ch;

    ch.on("broadcast", { event: "translation" }, ({ payload }) => {
      if (!payload) return;
      const msg: Msg = payload;
      setMessages((m) => [...m, msg]);

      // 🔊 Receiver-side TTS only:
      // - Don't speak if I'm the sender
      // - Only speak if the message's target language matches my UI language
      if (
        ttsEnabled &&
        typeof speak === "function" &&
        msg.senderId !== myPeerId &&
        langCore(msg.to) === langCore(myLanguage)
      ) {
        try {
          speak(msg.translatedText, msg.to);
        } catch (e) {
          console.warn("TTS speak failed:", e);
        }
      }
    });

    ch.subscribe();
    return () => ch.unsubscribe();
  }, [roomId, myPeerId, myLanguage, ttsEnabled, speak]);

  // add translation (local produce + broadcast). Sender NEVER speaks here.
  const addTranslation = async (text: string, from: string, to: string) => {
    const translated = await translateText(text, from, to);
    const msg: Msg = {
      id: crypto.randomUUID(),
      speaker: myName ?? "You",
      originalText: text,
      translatedText: translated,
      from,
      to,
      ts: Date.now(),
      senderId: myPeerId ?? "local",
    };

    // Append locally so the sender sees their own line immediately
    setMessages((m) => [...m, msg]);

    // Broadcast to others
    if (busRef.current) {
      busRef.current.send({
        type: "broadcast",
        event: "translation",
        payload: msg,
      });
    }
    return msg;
  };

  return { messages, addTranslation };
}


