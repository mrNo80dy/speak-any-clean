"use client";

import { useCallback, useEffect, useRef } from "react";

type AnySpeakTtsOpts = {
  /** Return the current preferred output language (e.g., targetLangRef.current). */
  getLang: () => string;
  /** Optional logger (kept generic so RoomPage can plug in its own log()). */
  onLog?: (msg: string, data?: any) => void;
};

/**
 * Any-Speak TTS helper:
 * - Provides a stable speakText() wrapper
 * - Performs a one-time “gesture unlock” for Android/Chrome where speechSynthesis can be silent
 */
export function useAnySpeakTts({ getLang, onLog }: AnySpeakTtsOpts) {
  const ttsUnlockedRef = useRef(false);
  // True while *our* most recent utterance is speaking. Useful for gating STT to avoid echo loops.
  const ttsSpeakingRef = useRef(false);

  const unlockTts = useCallback(() => {
    if (ttsUnlockedRef.current) return;
    if (typeof window === "undefined") return;

    const synth = window.speechSynthesis;
    if (!synth) return;

    try {
      // Mark unlocked first to avoid double-fire on multiple gesture events
      ttsUnlockedRef.current = true;

      // Some browsers keep speech synthesis "paused" until a user gesture.
      // Safe to call even if already running.
      // @ts-ignore
      synth.resume?.();

      // Speak a near-silent dot to satisfy gesture-gated audio.
      // Using volume ~0 avoids the user hearing anything.
      const u = new SpeechSynthesisUtterance(".");
      u.lang = getLang?.() || "en-US";
      u.rate = 1;
      u.volume = 0.001;
      u.onend = () => {
        try {
          synth.cancel();
        } catch {}
      };
      synth.speak(u);

      onLog?.("tts unlocked", {});
    } catch (e: any) {
      // If this fails, we'll try again on the next gesture
      ttsUnlockedRef.current = false;
      onLog?.("tts unlock failed", { message: e?.message || String(e) });
    }
  }, [getLang, onLog]);

  // One-time attempt to unlock TTS on the first user gesture (helps Android/Chrome play translated audio reliably)
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onGesture = () => unlockTts();

    window.addEventListener("pointerdown", onGesture, { once: true, capture: true });
    window.addEventListener("keydown", onGesture, { once: true, capture: true });

    return () => {
      window.removeEventListener("pointerdown", onGesture, true);
      window.removeEventListener("keydown", onGesture, true);
    };
  }, [unlockTts]);

  const speakText = useCallback(
    (text: string, lang: string, rate = 0.9, volume = 1) => {
      if (typeof window === "undefined") return;
      const synth = window.speechSynthesis;
      if (!synth) return;

      try {
        // @ts-ignore
        synth.resume?.();
      } catch {}

      const clean = (text || "").trim();
      if (!clean) return;

      const doSpeak = () => {
        try {
          synth.cancel();
        } catch {}

        const utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = lang || "en-US";
        utterance.rate = rate;
        utterance.volume = typeof volume === "number" ? volume : 1;

        // Mark speaking so STT can gate itself to avoid capturing our own translated audio.
        const setSpeaking = (v: boolean) => {
          ttsSpeakingRef.current = v;
          (window as any).__anyspeak_tts_speaking = v;
        };

        utterance.onstart = () => setSpeaking(true);
        utterance.onend = () => setSpeaking(false);

        const voices = synth.getVoices?.() || [];
        const match =
          voices.find((v) => v.lang === utterance.lang) ||
          voices.find((v) => v.lang.startsWith(utterance.lang.slice(0, 2)));

        if (match) utterance.voice = match;

        // (keep warning, but do not block cleanup)
        utterance.onerror = (e) => {
          try {
            setSpeaking(false);
          } catch {}
          console.warn("[TTS] error", e);
        };
        synth.speak(utterance);
      };

      const voices = synth.getVoices?.() || [];
      if (voices.length === 0) {
        setTimeout(doSpeak, 150);
        return;
      }

      doSpeak();
    },
    []
  );

  return {
    speakText,
    unlockTts,
    ttsUnlockedRef,
    ttsSpeakingRef,
  };
}
