"use client";

import { useCallback, useState } from "react";

export type AnySpeakChatMessage = {
  id: string;
  fromId: string;
  fromName: string;
  originalLang: string;
  translatedLang: string;
  originalText: string;
  translatedText: string;
  isLocal: boolean;
  at: number;
};

type Args = {
  max?: number; // max messages to keep in memory
};

export function useAnySpeakMessages(args: Args = {}) {
  const max = typeof args.max === "number" ? args.max : 30;

  const [messages, setMessages] = useState<AnySpeakChatMessage[]>([]);

  const pushMessage = useCallback(
    (msg: Omit<AnySpeakChatMessage, "id" | "at">) => {
      const full: AnySpeakChatMessage = {
        ...msg,
        id: crypto.randomUUID(),
        at: Date.now(),
      };

      setMessages((prev) => {
        const next = [...prev, full];
        return next.length > max ? next.slice(-max) : next;
      });

      return full;
    },
    [max]
  );

  const clearMessages = useCallback(() => setMessages([]), []);

  return {
    messages,
    pushMessage,
    clearMessages,
    setMessages, // exported for rare cases (debug), safe to ignore
  };
}
