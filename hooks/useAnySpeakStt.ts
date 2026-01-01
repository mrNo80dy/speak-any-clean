"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";

export type AnySpeakSttStatus = "unknown" | "ok" | "unsupported" | "error";

type Args = {
  isMobile: boolean;
  debugKey: string;
  speakLang: string;

  // Refs owned by the page (so other hooks/logic can coordinate)
  userTouchedMicRef: MutableRefObject<boolean>;
  micOnRef: MutableRefObject<boolean>;
  micArmedRef: MutableRefObject<boolean>;
  pttHeldRef: MutableRefObject<boolean>;

  // For desktop mic toggle UI state (WebRTC mic)
  micOn: boolean;
  setMicEnabled: (enabled: boolean) => void;

  // Utilities
  unlockTts: () => void;
  log: (msg: string, data?: any) => void;

  // Called whenever we want to send a final transcript (already handles translate + broadcast)
  onFinalTranscript: (text: string, recLang: string) => void;
};

export function useAnySpeakStt({
  isMobile,
  debugKey,
  speakLang,

  userTouchedMicRef,
  micOnRef,
  micArmedRef,
  pttHeldRef,

  micOn,
  setMicEnabled,

  unlockTts,
  log,
  onFinalTranscript,
}: Args) {
  const recognitionRef = useRef<any>(null);

  const sttRunningRef = useRef(false);
  const sttStopRequestedRef = useRef(false);
  const sttLastStartAtRef = useRef<number>(0);

  const sttRestartTimerRef = useRef<number | null>(null);
  const sttLastSentAtRef = useRef<number>(0);

  // Android finalize-on-silence refs
  const sttPendingTextRef = useRef<string>("");
  const sttFinalizeTimerRef = useRef<number | null>(null);

  // keep the last interim phrase so PTT up can still send even if onresult arrives late
  const sttLastInterimRef = useRef<string>("");

  // last sent used for spam prevention (kept in-hook)
  const sttLastSentRef = useRef<string>("");

  // flush timer so PTT up waits long enough for Android to emit final/onresult
  const sttFlushTimerRef = useRef<number | null>(null);

  const [sttListening, setSttListening] = useState(false); // reality (listening)
  const [sttArmedNotListening, setSttArmedNotListening] = useState(false);
  const [sttStatus, setSttStatus] = useState<AnySpeakSttStatus>("unknown");
  const [sttErrorMessage, setSttErrorMessage] = useState<string | null>(null);

  const clearSttRestartTimer = () => {
    if (sttRestartTimerRef.current) {
      window.clearTimeout(sttRestartTimerRef.current);
      sttRestartTimerRef.current = null;
    }
  };

  const clearFlushTimer = () => {
    if (sttFlushTimerRef.current) {
      window.clearTimeout(sttFlushTimerRef.current);
      sttFlushTimerRef.current = null;
    }
  };

  const clearFinalizeTimer = () => {
    if (sttFinalizeTimerRef.current) {
      window.clearTimeout(sttFinalizeTimerRef.current);
      sttFinalizeTimerRef.current = null;
    }
  };

  const sendFinalTranscript = (finalText: string, recLang: string) => {
    const text = (finalText || "").trim();
    if (!text) return;

    const lastExact = (sttLastSentRef.current || "").trim();
    if (lastExact && lastExact === text) return;

    // Prevent partial spam, but DON'T block real short phrases
    const last = (sttLastSentRef.current || "").trim();
    if (last) {
      if (last.startsWith(text) && last.length - text.length >= 2) return;
      if (text.startsWith(last) && last.length >= 10 && text.length - last.length < 4) return;
    }

    sttLastSentRef.current = text;
    sttLastSentAtRef.current = Date.now();

    onFinalTranscript(text, recLang || speakLang || "en-US");
  };

  const flushPendingStt = (why: string) => {
    clearFinalizeTimer();
    clearFlushTimer();

    // If we already sent something very recently, don't send again from flush.
    const msSinceLastSend = Date.now() - (sttLastSentAtRef.current || 0);
    if (msSinceLastSend < 900) {
      log("flushPendingStt: skipped (recent send)", { why, msSinceLastSend });
      return;
    }

    const pending = (sttPendingTextRef.current || "").trim();
    const interim = (sttLastInterimRef.current || "").trim();

    sttPendingTextRef.current = "";
    const chosen = pending || interim;

    if (!chosen) {
      log("flushPendingStt: no text", { why });
      return;
    }

    sttLastInterimRef.current = "";
    sendFinalTranscript(chosen, recognitionRef.current?.lang || speakLang);
    log("flushPendingStt: sent", { why, len: chosen.length });
  };

  const startSttNow = () => {
    const rec = recognitionRef.current;
    if (!rec) return;

    clearSttRestartTimer();
    clearFlushTimer();

    rec.lang = speakLang || "en-US";

    if (sttRunningRef.current) {
      log("stt start skipped (already running)", { lang: rec.lang });
      return;
    }

    sttStopRequestedRef.current = false;

    try {
      rec.start();
      log("stt start() called (gesture)", { lang: rec.lang });
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (msg.includes("already started")) {
        sttRunningRef.current = true;
        log("stt start() already running (ignored)", { lang: rec.lang });
      } else {
        log("stt start() FAILED", { message: msg, lang: rec.lang });
      }
    }
  };

  const stopSttNow = () => {
    const rec = recognitionRef.current;
    if (!rec) return;

    clearSttRestartTimer();

    sttStopRequestedRef.current = true;
    sttRunningRef.current = false;

    try {
      rec.stop();
      log("stt stop() called (gesture)");
    } catch (e: any) {
      log("stt stop() FAILED", { message: e?.message || String(e) });
    }
  };

  // ---- STT setup: Web Speech API -----------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as any;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      log("speech recognition not supported");
      setSttStatus("unsupported");
      setSttErrorMessage("Device browser does not support live captions.");
      return;
    }

    const prev = recognitionRef.current;
    if (prev) {
      try {
        prev.onend = null;
        prev.onresult = null;
        prev.onerror = null;
        prev.onstart = null;
        prev.stop();
      } catch {}
      recognitionRef.current = null;
    }

    const rec = new SpeechRecognitionCtor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = speakLang || "en-US";

    rec.onstart = () => {
      setSttArmedNotListening(false);
      setSttListening(true);

      sttLastStartAtRef.current = Date.now();
      sttRunningRef.current = true;
      sttStopRequestedRef.current = false;

      sttPendingTextRef.current = "";
      sttLastInterimRef.current = "";

      log("stt onstart", { lang: rec.lang });
      setSttStatus("ok");
      setSttErrorMessage(null);
    };

    rec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;

      rec.lang = speakLang || "en-US";

      let sawFinal = false;
      let newestText = "";

      for (let i = event.resultIndex ?? 0; i < results.length; i++) {
        const r = results[i];
        const t = (r?.[0]?.transcript || "").trim();
        if (!t) continue;

        newestText = t;
        sttLastInterimRef.current = t;

        if (r.isFinal) {
          sawFinal = true;

          // ✅ PTT FIX: while holding PTT on mobile, DO NOT send on finals.
          if (isMobile && pttHeldRef.current) {
            sttPendingTextRef.current = t;
            continue;
          }

          sttPendingTextRef.current = "";
          clearFinalizeTimer();
          sendFinalTranscript(t, rec.lang);
        }
      }

      // ✅ While holding PTT on mobile, do NOT run finalize-on-silence timer
      if (isMobile && pttHeldRef.current) {
        if (newestText) sttPendingTextRef.current = newestText;
        return;
      }

      // Desktop / non-PTT behavior: finalize on silence
      if (!sawFinal && newestText) {
        sttPendingTextRef.current = newestText;
        clearFinalizeTimer();

        sttFinalizeTimerRef.current = window.setTimeout(() => {
          const pending = sttPendingTextRef.current.trim();
          sttPendingTextRef.current = "";
          if (pending) sendFinalTranscript(pending, rec.lang);
        }, 1400);
      }
    };

    rec.onerror = (event: any) => {
      log("stt error", { error: event?.error, message: event?.message, event });
      setSttStatus("error");
      setSttErrorMessage(event?.error || event?.message || "Speech recognition error.");

      if (
        event?.error === "audio-capture" ||
        event?.error === "not-allowed" ||
        event?.error === "service-not-allowed"
      ) {
        sttStopRequestedRef.current = true;
        clearSttRestartTimer();
        clearFlushTimer();
        try {
          rec.stop();
        } catch {}
      }
    };

    rec.onend = () => {
      sttRunningRef.current = false;

      const ranForMs = Date.now() - (sttLastStartAtRef.current || Date.now());
      log("stt onend", { stopRequested: sttStopRequestedRef.current, ranForMs });

      if (!sttStopRequestedRef.current && ranForMs < 800) {
        log("stt ended too fast; disabling auto-restart", { ranForMs });
        setSttStatus("error");
        setSttErrorMessage(
          "Android Chrome ended captions mic instantly. Check mic permission, close other apps using mic, and reload the page."
        );
        sttStopRequestedRef.current = true;
        clearSttRestartTimer();
        clearFlushTimer();
        return;
      }

      // If we requested stop (PTT up), Android often emits late results.
      // So: schedule one last flush shortly after onend.
      if (sttStopRequestedRef.current) {
        clearFlushTimer();
        sttFlushTimerRef.current = window.setTimeout(() => {
          flushPendingStt("onend-after-stop");
          setSttListening(false);
        }, 300);
      }

      // Android: don't auto-restart
      if (isMobile) {
        setSttListening(false);

        if (micArmedRef.current && !sttStopRequestedRef.current) {
          setSttArmedNotListening(true);
          log("stt ended (mobile) — needs manual resume", { ranForMs });
        }
        return;
      }

      // Desktop: keep auto-restart
      if (micOnRef.current && !sttStopRequestedRef.current) {
        clearSttRestartTimer();
        sttRestartTimerRef.current = window.setTimeout(() => {
          try {
            if (!sttRunningRef.current) {
              rec.start();
              log("stt auto-restart start() called", { lang: rec.lang });
            }
          } catch (e: any) {
            log("stt auto-restart FAILED", { message: e?.message || String(e) });
          }
        }, 400);
      }
    };

    recognitionRef.current = rec;

    return () => {
      clearFinalizeTimer();
      clearSttRestartTimer();
      clearFlushTimer();
      sttPendingTextRef.current = "";
      sttLastInterimRef.current = "";
      try {
        rec.stop();
      } catch {}
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debugKey, speakLang, isMobile]);

  // ---- UI controls ------------------------------------------
  const toggleMic = async () => {
    userTouchedMicRef.current = true;
    unlockTts();

    if (isMobile) {
      if (sttListening) {
        micArmedRef.current = false;
        setSttArmedNotListening(false);
        stopSttNow();
        setSttListening(false);

        clearFlushTimer();
        sttFlushTimerRef.current = window.setTimeout(() => {
          flushPendingStt("toggleMic-off");
        }, 650);

        log("mobile mic OFF (stt)", {});
        return;
      } else {
        micArmedRef.current = true;
        setSttArmedNotListening(false);
        startSttNow();
        log("mobile mic ON (stt)", {});
        return;
      }
    }

    const next = !micOn;
    micOnRef.current = next;

    if (!next) setSttArmedNotListening(false);

    setMicEnabled(next);

    if (next && sttStatus !== "unsupported") startSttNow();
    else stopSttNow();
  };

  // PTT helpers (page handles pointer capture/release)
  const pttDown = () => {
    if (!isMobile) return;

    pttHeldRef.current = true;
    userTouchedMicRef.current = true;
    unlockTts();
    micArmedRef.current = true;
    setSttArmedNotListening(false);

    sttPendingTextRef.current = "";
    sttLastInterimRef.current = "";

    startSttNow();
    setSttListening(true);
    log("PTT down", {});
  };

  const pttUp = () => {
    if (!isMobile) return;

    pttHeldRef.current = false;
    micArmedRef.current = false;
    stopSttNow();

    clearFlushTimer();
    sttFlushTimerRef.current = window.setTimeout(() => {
      flushPendingStt("PTT up");
      setSttListening(false);
      log("PTT up", {});
    }, 650);
  };

  const pttCancel = () => {
    if (!isMobile) return;
    if (!pttHeldRef.current) return;

    pttHeldRef.current = false;
    micArmedRef.current = false;
    stopSttNow();

    clearFlushTimer();
    sttFlushTimerRef.current = window.setTimeout(() => {
      flushPendingStt("PTT cancel");
      setSttListening(false);
      log("PTT cancel", {});
    }, 650);
  };

  const stopAllStt = (why: string) => {
    micOnRef.current = false;
    micArmedRef.current = false;
    setSttListening(false);
    setSttArmedNotListening(false);
    stopSttNow();
    clearFlushTimer();
    sttFlushTimerRef.current = window.setTimeout(() => {
      flushPendingStt(why);
    }, 300);
  };

  return {
    sttListening,
    sttArmedNotListening,
    sttStatus,
    sttErrorMessage,

    toggleMic,
    pttDown,
    pttUp,
    pttCancel,

    startSttNow,
    stopSttNow,
    stopAllStt,
  };
}
