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

  // ---- Option A: mic-stream + VAD + chunked STT (mobile) -----------------
  const pipelineStreamRef = useRef<MediaStream | null>(null);
  const pipelineRecorderRef = useRef<MediaRecorder | null>(null);
  const pipelineAudioCtxRef = useRef<AudioContext | null>(null);
  const pipelineAnalyserRef = useRef<AnalyserNode | null>(null);
  const pipelineSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const pipelineVadRafRef = useRef<number | null>(null);

  // Rolling buffer (for preroll) and current utterance collection.
  const pipelineRollingRef = useRef<Array<{ t: number; b: Blob }>>([]);
  const pipelineUtteranceRef = useRef<Array<Blob>>([]);
  const pipelineSpeechingRef = useRef(false);
  const pipelineLastVoiceAtRef = useRef<number>(0);

  // Serialize STT uploads so we don't overlap requests.
  const pipelineInFlightRef = useRef(false);
  const pipelineQueueRef = useRef<Array<{ blob: Blob; lang: string }>>([]);

  const sttRunningRef = useRef(false);
  const sttStopRequestedRef = useRef(false);
  const sttLastStartAtRef = useRef<number>(0);

  const sttRestartTimerRef = useRef<number | null>(null);
  const sttLastSentAtRef = useRef<number>(0);

  // Auto-restart backoff (especially for mobile Web Speech)
  const sttAutoRestartWindowStartRef = useRef<number>(0);
  const sttAutoRestartCountRef = useRef<number>(0);

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

  const isTtsSpeaking = () => {
    try {
      return !!(window as any).__anyspeak_tts_speaking;
    } catch {
      return false;
    }
  };

  // ----- Option A (mobile) pipeline helpers ------------------------------
  const stopVadLoop = () => {
    if (pipelineVadRafRef.current) {
      cancelAnimationFrame(pipelineVadRafRef.current);
      pipelineVadRafRef.current = null;
    }
  };

  const hardStopPipeline = (why: string) => {
    stopVadLoop();
    pipelineSpeechingRef.current = false;
    pipelineUtteranceRef.current = [];
    pipelineRollingRef.current = [];

    const rec = pipelineRecorderRef.current;
    pipelineRecorderRef.current = null;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {}
    }

    const stream = pipelineStreamRef.current;
    pipelineStreamRef.current = null;
    if (stream) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {}
    }

    const ctx = pipelineAudioCtxRef.current;
    pipelineAudioCtxRef.current = null;
    pipelineAnalyserRef.current = null;
    pipelineSourceRef.current = null;
    if (ctx) {
      try {
        ctx.close();
      } catch {}
    }

    log("pipeline stopped", { why });
  };

  const postSttBlob = async (blob: Blob, lang: string) => {
    const fd = new FormData();
    fd.append("file", blob, "audio.webm");
    fd.append("lang", lang || speakLang || "en-US");
    const r = await fetch("/api/stt", { method: "POST", body: fd });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      throw new Error(`stt http ${r.status}: ${txt}`);
    }
    const data: any = await r.json().catch(() => null);
    return (data?.text as string | undefined) || "";
  };

  const drainPipelineQueue = async () => {
    if (pipelineInFlightRef.current) return;
    pipelineInFlightRef.current = true;
    try {
      while (pipelineQueueRef.current.length) {
        const item = pipelineQueueRef.current.shift()!;
        const started = Date.now();
        try {
          const text = (await postSttBlob(item.blob, item.lang)).trim();
          log("pipeline stt returned", { ms: Date.now() - started, len: text.length });
          if (text) sendFinalTranscript(text, item.lang || speakLang);
        } catch (e: any) {
          log("pipeline stt failed", { message: e?.message || String(e) });
        }
      }
    } finally {
      pipelineInFlightRef.current = false;
    }
  };

  const enqueueUtterance = (blob: Blob, lang: string) => {
    // Avoid runaway memory in pathological cases
    if (pipelineQueueRef.current.length > 6) pipelineQueueRef.current.shift();
    pipelineQueueRef.current.push({ blob, lang });
    void drainPipelineQueue();
  };

  const endSpeechIfNeeded = (why: string) => {
    if (!pipelineSpeechingRef.current) return;
    pipelineSpeechingRef.current = false;

    // Move utterance chunks into a single blob and send
    const chunks = pipelineUtteranceRef.current;
    pipelineUtteranceRef.current = [];

    const blob = new Blob(chunks, { type: chunks?.[0]?.type || "audio/webm" });
    log("pipeline utterance end", { why, bytes: blob.size });

    // Ignore extremely small blobs (clicks / accidental noise)
    if (blob.size < 2500) return;
    enqueueUtterance(blob, speakLang || "en-US");
  };

  const startPipeline = async () => {
    if (pipelineRecorderRef.current || pipelineStreamRef.current) {
      log("pipeline start skipped (already running)");
      return;
    }

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setSttStatus("unsupported");
      setSttErrorMessage("Device browser does not support microphone capture.");
      return;
    }

    setSttStatus("ok");
    setSttErrorMessage(null);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    pipelineStreamRef.current = stream;

    // Recorder (opus/webm)
    const mimeCandidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ];
    let mime: string | undefined;
    for (const m of mimeCandidates) {
      if ((window as any).MediaRecorder?.isTypeSupported?.(m)) {
        mime = m;
        break;
      }
    }

    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    pipelineRecorderRef.current = rec;

    // VAD graph (RMS via analyser)
    const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
    const ctx: AudioContext = new AudioCtx();
    pipelineAudioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    pipelineSourceRef.current = src;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    pipelineAnalyserRef.current = analyser;
    src.connect(analyser);

    // Keep a short rolling buffer for preroll.
    const PREROLL_MS = 350;
    const ROLLING_KEEP_MS = 1400;

    rec.ondataavailable = (e: BlobEvent) => {
      const b = e.data;
      if (!b || b.size === 0) return;
      const now = Date.now();

      // Rolling buffer
      const roll = pipelineRollingRef.current;
      roll.push({ t: now, b });
      while (roll.length && now - roll[0].t > ROLLING_KEEP_MS) roll.shift();

      // If we're currently in speech, also collect
      if (pipelineSpeechingRef.current) {
        pipelineUtteranceRef.current.push(b);
      }
    };

    rec.onerror = (e: any) => {
      log("pipeline recorder error", { e: String(e) });
      hardStopPipeline("recorder-error");
      setSttStatus("error");
      setSttErrorMessage("Microphone recorder error. Try reloading.");
    };

    rec.onstart = () => {
      log("pipeline recorder started", { mime: rec.mimeType });
    };

    // Start the recorder in small slices so we can segment utterances.
    rec.start(250);

    // VAD loop
    const data = new Uint8Array(analyser.fftSize);
    const SILENCE_END_MS = 700;
    const START_THRESH = 0.015; // tuned for typical phone mic; adjust if needed
    const CONTINUE_THRESH = 0.010;

    const tick = () => {
      pipelineVadRafRef.current = requestAnimationFrame(tick);
      if (!pipelineRecorderRef.current) return;

      // Gate STT while TTS is speaking (avoid echo loops)
      if (isTtsSpeaking()) {
        pipelineLastVoiceAtRef.current = Date.now();
        if (pipelineSpeechingRef.current) {
          // treat as silence boundary
          endSpeechIfNeeded("tts-gate");
        }
        return;
      }

      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const now = Date.now();

      const thresh = pipelineSpeechingRef.current ? CONTINUE_THRESH : START_THRESH;
      const voiced = rms >= thresh;

      if (voiced) {
        pipelineLastVoiceAtRef.current = now;
        if (!pipelineSpeechingRef.current) {
          pipelineSpeechingRef.current = true;
          pipelineUtteranceRef.current = [];
          // Preroll: include last ~350ms of rolling audio
          const roll = pipelineRollingRef.current;
          const preroll = roll.filter((x) => now - x.t <= PREROLL_MS).map((x) => x.b);
          pipelineUtteranceRef.current.push(...preroll);
          log("pipeline speech start", { rms: Number(rms.toFixed(4)) });
        }
      } else {
        // silence
        if (pipelineSpeechingRef.current) {
          const msSilent = now - (pipelineLastVoiceAtRef.current || now);
          if (msSilent > SILENCE_END_MS) {
            endSpeechIfNeeded("silence");
          }
        }
      }
    };

    pipelineLastVoiceAtRef.current = Date.now();
    tick();

    // reflect UI
    setSttListening(true);
    setSttArmedNotListening(false);
  };

  const stopPipeline = (why: string) => {
    // flush any in-progress utterance
    endSpeechIfNeeded(why);
    hardStopPipeline(why);
    setSttListening(false);
    setSttArmedNotListening(false);
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

  const scheduleAutoRestart = (reason: string, delayMs = 450) => {
    const rec = recognitionRef.current;
    if (!rec) return;

    // Only restart if user intends mic to be on/armed and we didn't request stop.
    if (sttStopRequestedRef.current) return;
    if (!micArmedRef.current && !micOnRef.current) return;

    // Backoff window to avoid tight restart loops on Android.
    const now = Date.now();
    const winStart = sttAutoRestartWindowStartRef.current || 0;
    if (!winStart || now - winStart > 12000) {
      sttAutoRestartWindowStartRef.current = now;
      sttAutoRestartCountRef.current = 0;
    }
    sttAutoRestartCountRef.current += 1;

    if (sttAutoRestartCountRef.current > 8) {
      log("stt auto-restart: too many restarts; disabling", {
        reason,
        count: sttAutoRestartCountRef.current,
      });
      setSttStatus("error");
      setSttErrorMessage(
        "Captions mic kept stopping on this device. Try reloading, closing other apps using the mic, or switching browsers."
      );
      sttStopRequestedRef.current = true;
      return;
    }

    clearSttRestartTimer();
    sttRestartTimerRef.current = window.setTimeout(() => {
      try {
        if (!sttRunningRef.current) {
          rec.lang = speakLang || "en-US";
          rec.start();
          log("stt auto-restart start() called", { reason, lang: rec.lang });
        }
      } catch (e: any) {
        log("stt auto-restart FAILED", { reason, message: e?.message || String(e) });
      }
    }, delayMs) as any;
  };

  // ---- STT setup: Web Speech API -----------------------------
  useEffect(() => {
    if (typeof window === "undefined") return;

    // Option A: On mobile we use MediaRecorder + VAD + /api/stt instead of Web Speech.
    if (isMobile) {
      const hasRecorder = typeof (window as any).MediaRecorder !== "undefined";
      const hasGetUserMedia = !!navigator.mediaDevices?.getUserMedia;
      if (!hasRecorder || !hasGetUserMedia) {
        setSttStatus("unsupported");
        setSttErrorMessage("Device browser does not support live captions.");
      } else {
        setSttStatus("ok");
        setSttErrorMessage(null);
      }

      return () => {
        // Ensure we don't leave the mic open when navigating away.
        try {
          stopPipeline("unmount");
        } catch {}
      };
    }

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
  const code = event?.error;
  log("stt error", { error: code, message: event?.message, event });
  setSttStatus("error");
  setSttErrorMessage(code || event?.message || "Speech recognition error.");

  // Fatal errors: we must stop and require user action
  if (code === "not-allowed" || code === "service-not-allowed") {
    sttStopRequestedRef.current = true;
    micArmedRef.current = false;
    setSttArmedNotListening(false);
    clearSttRestartTimer();
    clearFlushTimer();
    try {
      rec.stop();
    } catch {}
    return;
  }

  // Audio capture issues: often transient on mobile. Try to restart if user still wants mic on.
  if (code === "audio-capture") {
    // don't permanently disarm; schedule a restart with a bit more delay
    sttRunningRef.current = false;
    scheduleAutoRestart("audio-capture", 900);
    return;
  }

  // Common transient errors on mobile: no-speech, aborted, network.
  // Keep the mic armed and restart quietly.
  if (code === "no-speech" || code === "aborted" || code === "network") {
    sttRunningRef.current = false;
    scheduleAutoRestart(String(code || "transient-error"), 700);
    return;
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

// Mobile: auto-restart if the user still has mic armed (hands-free mode).
if (isMobile) {
  // IMPORTANT: On mobile, Web Speech often ends after a few seconds of silence.
  // If the user still wants the mic on, treat onend as a normal boundary and restart
  // WITHOUT flipping the UI to "off" (otherwise it feels like it stopped working).
  if (micArmedRef.current && !sttStopRequestedRef.current) {
    // Keep UI in "listening" state while we schedule a restart.
    setSttListening(true);
    setSttArmedNotListening(false);

    scheduleAutoRestart("mobile-onend", 550);
    log("stt ended (mobile) — scheduling auto-restart", { ranForMs });
  } else if (sttStopRequestedRef.current) {
    // User explicitly stopped (mic button / PTT).
    setSttListening(false);
    setSttArmedNotListening(micArmedRef.current);
    log("stt ended (mobile) — stop requested", { ranForMs });
  } else {
    // Not armed: just reflect reality.
    setSttListening(false);
    setSttArmedNotListening(false);
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
        stopPipeline("toggleMic-off");

        log("mobile mic OFF (pipeline)", {});
        return;
      } else {
        micArmedRef.current = true;
        setSttArmedNotListening(false);
        await startPipeline();
        log("mobile mic ON (pipeline)", {});
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

    // In Option A, PTT simply arms the pipeline for the duration of the press.
    void startPipeline();
    log("PTT down (pipeline)", {});
  };

  const pttUp = () => {
    if (!isMobile) return;

    pttHeldRef.current = false;
    micArmedRef.current = false;
    stopPipeline("PTT up");
    log("PTT up (pipeline)", {});
  };

  const pttCancel = () => {
    if (!isMobile) return;
    if (!pttHeldRef.current) return;

    pttHeldRef.current = false;
    micArmedRef.current = false;
    stopPipeline("PTT cancel");
    log("PTT cancel (pipeline)", {});
  };

  const stopAllStt = (why: string) => {
    micOnRef.current = false;
    micArmedRef.current = false;
    setSttListening(false);
    setSttArmedNotListening(false);
    if (isMobile) {
      stopPipeline(why);
      return;
    }
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
