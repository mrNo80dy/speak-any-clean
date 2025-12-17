"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { LANGUAGES, type LanguageConfig } from "@/lib/languages";
import { LESSONS } from "@/lib/lessons.generated";

type TranslateResponse = {
  translatedText?: string;
  targetLang?: string;
  error?: string;
};

type LessonPhrase = {
  id: string;
  texts: Record<string, string>;
};

async function translateText(
  fromLang: string,
  toLang: string,
  text: string
): Promise<{ translatedText: string; targetLang: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { translatedText: "", targetLang: toLang };
  if (fromLang === toLang) return { translatedText: trimmed, targetLang: toLang };

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: trimmed, fromLang, toLang }),
    });

    if (!res.ok) {
      console.error("[Learn] translate API not ok", res.status);
      return { translatedText: trimmed, targetLang: toLang };
    }

    const data: TranslateResponse = await res.json();
    if (!data || !data.translatedText) {
      console.warn("[Learn] translate API missing translatedText", data);
      return { translatedText: trimmed, targetLang: toLang };
    }

    return { translatedText: data.translatedText, targetLang: data.targetLang || toLang };
  } catch (err) {
    console.error("[Learn] translate API failed", err);
    return { translatedText: trimmed, targetLang: toLang };
  }
}

// Kept for future fallback / debugging (not used when lessons.generated is complete)
async function translateMany(
  items: { id: string; text: string; fromLang: string; toLang: string }[]
): Promise<Record<string, string>> {
  if (!items.length) return {};

  const res = await fetch("/api/translateMany", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  });

  if (!res.ok) {
    console.error("[Learn] translateMany not ok", res.status);
    return {};
  }

  const data = (await res.json()) as {
    results?: { id: string; translatedText?: string }[];
  };

  const map: Record<string, string> = {};
  for (const r of data?.results ?? []) {
    if (r?.id) map[r.id] = r.translatedText ?? "";
  }
  return map;
}

function speakText(text: string, lang: string, rate = 1.0) {
  if (typeof window === "undefined") return;
  const synth = window.speechSynthesis;
  if (!synth) {
    console.warn("[Learn] speechSynthesis not available");
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  const doSpeak = () => {
    try {
      synth.cancel();
    } catch {}

    const utterance = new SpeechSynthesisUtterance(trimmed);
    const voices = synth.getVoices();

    if (voices && voices.length > 0) {
      const voice =
        voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
        voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
      if (voice) utterance.voice = voice;
    }

    utterance.lang = lang || "en-US";
    utterance.rate = rate;
    synth.speak(utterance);
  };

  const currentVoices = synth.getVoices();
  if (!currentVoices || currentVoices.length === 0) {
    synth.onvoiceschanged = () => {
      synth.onvoiceschanged = null;
      doSpeak();
    };
    return;
  }

  doSpeak();
}

async function playViaApiTts(text: string, voice: string, format: "mp3" | "wav" = "mp3") {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, format }),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(`TTS failed (${res.status}). ${msg}`);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);

  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  await audio.play();
}

function mapGenderToVoice(gender: "female" | "male") {
  // Change these anytime after you listen and pick favorites.
  // These are safe defaults.
  return gender === "male" ? "echo" : "alloy";
}

function scoreSimilarity(a: string, b: string): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[.,!?;:]/g, "")
      .replace(/\s+/g, " ")
      .trim();

  const aa = normalize(a);
  const bb = normalize(b);
  if (!aa || !bb) return 0;

  const aWords = aa.split(" ");
  const bWords = bb.split(" ");

  let matches = 0;
  const maxLen = Math.max(aWords.length, bWords.length);
  for (let i = 0; i < maxLen; i++) {
    if (aWords[i] && bWords[i] && aWords[i] === bWords[i]) matches++;
  }

  return Math.round((matches / maxLen) * 100);
}

function normalizeWords(s: string) {
  return s
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

export default function LearnPage() {
  const defaultLang = typeof navigator !== "undefined" ? navigator.language : "en-US";

  const [fromLang, setFromLang] = useState(defaultLang);
  const [toLang, setToLang] = useState("en-US");

  const [inputMode, setInputMode] = useState<"type" | "speak">("type");

  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attemptText, setAttemptText] = useState("");
  const [attemptScore, setAttemptScore] = useState<number | null>(null);

  const [isRecordingSource, setIsRecordingSource] = useState(false);
  const [isRecordingAttempt, setIsRecordingAttempt] = useState(false);
  const [sttSupported, setSttSupported] = useState<boolean | null>(null);

  // Device TTS speed (speechSynthesis only)
  const [ttsRate, setTtsRate] = useState<number>(0.85);

  // NEW: AI voice toggle + gender preference
  const [useAiVoice, setUseAiVoice] = useState(false);
  const [voiceGender, setVoiceGender] = useState<"female" | "male">("female");

  const sourceRecRef = useRef<any>(null);
  const attemptRecRef = useRef<any>(null);

  const [selectedLessonId, setSelectedLessonId] = useState<string>("introductions");

  // Keeping this around (it won't be needed once lessons.generated is complete for all langs)
  const [lessonPreviewCache, setLessonPreviewCache] = useState<Record<string, string>>({});
  const lessonPreviewCacheRef = useRef<Record<string, string>>({});

  useEffect(() => {
    lessonPreviewCacheRef.current = lessonPreviewCache;
  }, [lessonPreviewCache]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as any;
    const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      console.warn("[Learn] SpeechRecognition not supported on this device");
      setSttSupported(false);
      return;
    }

    setSttSupported(true);

    const srcRec = new SpeechRecognitionCtor();
    srcRec.continuous = false;
    srcRec.interimResults = false;
    srcRec.lang = fromLang;

    srcRec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;
      const last = results[results.length - 1];
      const raw = last[0]?.transcript || "";
      setSourceText(raw.trim());
      setIsRecordingSource(false);
      setInputMode("type");
    };

    srcRec.onerror = (event: any) => {
      console.error("[Learn] source STT error", event.error);
      setError(event.error || "Speech recognition error.");
      setIsRecordingSource(false);
      setInputMode("type");
    };

    srcRec.onend = () => {
      setIsRecordingSource(false);
    };

    const attRec = new SpeechRecognitionCtor();
    attRec.continuous = false;
    attRec.interimResults = false;
    attRec.lang = toLang;

    attRec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;
      const last = results[results.length - 1];
      const raw = last[0]?.transcript || "";
      const text = raw.trim();
      setAttemptText(text);

      if (translatedText) setAttemptScore(scoreSimilarity(translatedText, text));
      setIsRecordingAttempt(false);
    };

    attRec.onerror = (event: any) => {
      console.error("[Learn] attempt STT error", event.error);
      setError(event.error || "Speech recognition error.");
      setIsRecordingAttempt(false);
    };

    attRec.onend = () => {
      setIsRecordingAttempt(false);
    };

    sourceRecRef.current = srcRec;
    attemptRecRef.current = attRec;

    return () => {
      try {
        srcRec.stop();
        attRec.stop();
      } catch {}
      sourceRecRef.current = null;
      attemptRecRef.current = null;
    };
  }, [fromLang, toLang, translatedText]);

  const selectedLesson = LESSONS.find((l) => l.id === selectedLessonId);

  // With lessons.generated this should rarely do anything.
  useEffect(() => {
    let cancelled = false;

    async function warmLessonPreviews() {
      if (!selectedLesson) return;

      const updates: Record<string, string> = {};
      const toTranslate: { id: string; text: string; fromLang: string; toLang: string }[] = [];

      for (const phrase of selectedLesson.phrases) {
        const cacheKey = `${phrase.id}|${fromLang}`;

        if (lessonPreviewCacheRef.current[cacheKey]) continue;

        const direct = phrase.texts[fromLang];
        if (direct) {
          updates[cacheKey] = direct;
          continue;
        }

        const englishSeed = phrase.texts["en-US"] ?? Object.values(phrase.texts)[0] ?? "";
        if (!englishSeed) continue;

        if (fromLang === "en-US") {
          updates[cacheKey] = englishSeed;
          continue;
        }

        // Fallback only (should not happen if generated file includes this language)
        toTranslate.push({
          id: cacheKey,
          text: englishSeed,
          fromLang: "en-US",
          toLang: fromLang,
        });
      }

      if (toTranslate.length) {
        const translatedMap = await translateMany(toTranslate);
        if (cancelled) return;

        for (const [cacheKey, translated] of Object.entries(translatedMap)) {
          if (translated) updates[cacheKey] = translated;
        }
      }

      if (cancelled) return;

      if (Object.keys(updates).length > 0) {
        setLessonPreviewCache((prev) => ({ ...prev, ...updates }));
      }
    }

    void warmLessonPreviews();

    return () => {
      cancelled = true;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromLang, selectedLessonId, selectedLesson]);

  async function handleTranslate() {
    setError(null);
    setLoading(true);
    setAttemptText("");
    setAttemptScore(null);

    try {
      const { translatedText } = await translateText(fromLang, toLang, sourceText);
      setTranslatedText(translatedText);
    } catch (err: any) {
      console.error("[Learn] translate error", err);
      setError(err?.message || "Unexpected error in Learn translate.");
    } finally {
      setLoading(false);
    }
  }

  function handlePlaySource() {
    speakText(sourceText, fromLang, 1.0);
  }

  async function handlePlayTarget() {
    const t = translatedText.trim();
    if (!t) return;

    if (!useAiVoice) {
      speakText(t, toLang, ttsRate);
      return;
    }

    try {
      const voice = mapGenderToVoice(voiceGender);
      await playViaApiTts(t, voice, "mp3");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || "AI voice failed. Falling back to device voice.");
      speakText(t, toLang, ttsRate);
    }
  }

  function handleStartSourceRecord() {
    setError(null);
    if (!sttSupported || !sourceRecRef.current) {
      setError("Speech input isn’t supported on this device. You can still type and translate.");
      return;
    }
    try {
      setIsRecordingSource(true);
      sourceRecRef.current.lang = fromLang;
      sourceRecRef.current.start();
    } catch (err) {
      console.error("[Learn] start source error", err);
      setIsRecordingSource(false);
    }
  }

  function handleStartAttemptRecord() {
    setError(null);
    if (!translatedText.trim()) return;
    if (!sttSupported || !attemptRecRef.current) {
      setError("Speech practice isn’t supported on this device. You can still listen and repeat.");
      return;
    }
    try {
      setIsRecordingAttempt(true);
      setAttemptText("");
      setAttemptScore(null);
      attemptRecRef.current.lang = toLang;
      attemptRecRef.current.start();
    } catch (err) {
      console.error("[Learn] start attempt error", err);
      setIsRecordingAttempt(false);
    }
  }

  const sttWarning =
    sttSupported === false
      ? "Speech features are not supported on this browser. You can still type, translate, and listen."
      : null;

  async function handleUseLessonPhrase(phrase: LessonPhrase) {
    setError(null);
    setAttemptText("");
    setAttemptScore(null);

    const source =
      phrase.texts[fromLang] ?? phrase.texts["en-US"] ?? Object.values(phrase.texts)[0] ?? "";
    setSourceText(source);

    const target = phrase.texts[toLang];
    if (target) {
      setTranslatedText(target);
      return;
    }

    // Fallback only (should rarely happen if generated file is complete)
    setLoading(true);
    try {
      const res = await translateText(fromLang, toLang, source);
      setTranslatedText(res.translatedText);
    } finally {
      setLoading(false);
    }
  }

  const highlightedTranslation = useMemo(() => {
    if (!translatedText.trim()) return null;

    const originalWords = translatedText.split(/\s+/).filter(Boolean);
    const idealNorm = normalizeWords(translatedText);
    const attemptNorm = normalizeWords(attemptText || "");

    const hasAttempt = attemptText.trim().length > 0;

    return (
      <div className="leading-relaxed">
        {originalWords.map((w, i) => {
          if (!hasAttempt) {
            return (
              <span key={`${w}-${i}`} className="text-slate-50">
                {w}
                {i < originalWords.length - 1 ? " " : ""}
              </span>
            );
          }

          const ok = idealNorm[i] && attemptNorm[i] && idealNorm[i] === attemptNorm[i];
          return (
            <span
              key={`${w}-${i}`}
              className={`px-0.5 rounded ${
                ok ? "bg-emerald-500/15 text-emerald-100" : "bg-red-500/15 text-red-100"
              }`}
            >
              {w}
              {i < originalWords.length - 1 ? " " : ""}
            </span>
          );
        })}
      </div>
    );
  }, [translatedText, attemptText]);

  function toggleInputMode() {
    if (inputMode === "type") {
      setInputMode("speak");
      setTimeout(() => handleStartSourceRecord(), 0);
    } else {
      setInputMode("type");
      try {
        sourceRecRef.current?.stop?.();
      } catch {}
      setIsRecordingSource(false);
    }
  }

 return (
  <div className="min-h-screen bg-background text-foreground">
    <AppHeader />
    <main className="mx-auto max-w-3xl px-4 py-8">
      {/* your existing Learn UI */}

      <Card className="w-full max-w-xl md:max-w-2xl shadow-lg flex flex-col">

        <CardHeader className="pb-2 text-center">
          <CardTitle className="text-2xl font-bold">Any-Speak Learn</CardTitle>
<p className="text-sm text-muted-foreground mt-1">
  Type or speak in your language, hear it in another, then practice saying it.
</p>

        </CardHeader>

        <CardContent className="space-y-3 px-5 pb-3">
          {/* Language selectors */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-slate-100">From language</Label>
              <select
                value={fromLang}
                onChange={(e) => setFromLang(e.target.value)}
                className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LANGUAGES.map((lang: LanguageConfig) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-100">To language</Label>
              <select
                value={toLang}
                onChange={(e) => setToLang(e.target.value)}
                className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LANGUAGES.map((lang: LanguageConfig) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Your sentence */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-xs text-slate-100">Your sentence</Label>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handlePlaySource}
                  disabled={!sourceText.trim()}
                  className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-[11px]"
                >
                  Play original
                </Button>

                <Button
                  size="sm"
                  variant="outline"
                  onClick={toggleInputMode}
                  disabled={sttSupported === false}
                  className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-[11px]"
                >
                  {inputMode === "speak"
                    ? isRecordingSource
                      ? "Listening…"
                      : "Speak mode"
                    : "Type mode"}
                </Button>
              </div>
            </div>

            <Textarea
              rows={3}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder={inputMode === "speak" ? "Listening… speak now" : "Type what you want to say…"}
              disabled={inputMode === "speak"}
              className="bg-slate-900 border border-slate-500 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-70"
            />
          </div>

          {/* Translate row */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleTranslate}
              disabled={loading || !sourceText.trim()}
              className="bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold disabled:opacity-60 text-sm"
            >
              {loading ? "Translating…" : "Translate"}
            </Button>

            <Button
              variant="outline"
              onClick={() => void handlePlayTarget()}
              disabled={!translatedText.trim()}
              className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-sm"
            >
              Play translation
            </Button>

            <div className="flex items-center gap-2 px-2 py-1 rounded-md border border-slate-600 bg-slate-900">
              <span className="text-[11px] text-slate-200">Speed</span>
              <input
                type="range"
                min={0.6}
                max={1.2}
                step={0.05}
                value={ttsRate}
                onChange={(e) => setTtsRate(Number(e.target.value))}
                disabled={useAiVoice}
              />
              <span className="text-[11px] text-slate-200 w-10 text-right">
                {ttsRate.toFixed(2)}x
              </span>
            </div>

            {/* NEW: AI voice toggle */}
            {/*
            <div className="flex items-center gap-3 px-2 py-1 rounded-md border border-slate-600 bg-slate-900">
              <label className="flex items-center gap-2 text-[11px] text-slate-200">
                <input
                  type="checkbox"
                  checked={useAiVoice}
                  onChange={(e) => setUseAiVoice(e.target.checked)}
                />
                Any-Speak AI voice
              </label>

              <select
                value={voiceGender}
                onChange={(e) => setVoiceGender(e.target.value as "female" | "male")}
                className="rounded-md border border-slate-600 bg-slate-950 px-2 py-1 text-[11px] text-slate-100"
                disabled={!useAiVoice}
              >
                <option value="female">Female</option>
                <option value="male">Male</option>
              </select>
            </div>
            */}
          </div>

          {error && (
            <div className="text-[11px] text-red-200">
              {error === "not-allowed"
                ? "Mic access was blocked by the browser. Check the microphone permission if you want to use speech input."
                : error}
            </div>
          )}

          {sttWarning && <div className="text-[11px] text-amber-200">{sttWarning}</div>}

          {/* Translated sentence */}
          <div className="space-y-1">
            <Label className="text-xs text-slate-100">Translated sentence</Label>
            <div className="min-h-[2.5rem] rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-sm text-slate-50">
              {translatedText ? (
                highlightedTranslation
              ) : (
                <span className="text-slate-400">Translate a sentence to see it here.</span>
              )}
            </div>
            {attemptText.trim() && (
              <div className="text-[11px] text-slate-300">
                Green = matched word, Red = needs work (rough, position-based).
              </div>
            )}
          </div>

          {/* Practice */}
          <div className="space-y-2 border-t border-slate-600 pt-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm text-slate-100">Practice speaking the translation</Label>
              <Button
                size="sm"
                onClick={handleStartAttemptRecord}
                disabled={!translatedText.trim() || isRecordingAttempt}
                className="bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold disabled:opacity-60 text-[11px]"
              >
                {isRecordingAttempt ? "Listening…" : "Record my attempt"}
              </Button>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-slate-300">What you said (recognized)</Label>
              <div className="min-h-[2.5rem] rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-sm text-slate-50">
                {attemptText || (
                  <span className="text-slate-400">
                    After recording, your attempt will appear here in the target language.
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-slate-300">Accuracy (rough estimate)</Label>
              <div className="text-sm text-slate-50">
                {attemptScore === null ? (
                  <span className="text-slate-400">You&apos;ll see a score after an attempt.</span>
                ) : (
                  <span>{attemptScore}% match to the ideal sentence.</span>
                )}
              </div>
            </div>
          </div>

          {/* Lesson mode */}
          <div className="space-y-2 border-t border-slate-600 pt-2 pb-1">
            <Label className="text-sm text-slate-100">Lesson mode (guided phrases)</Label>

            <select
              value={selectedLessonId}
              onChange={(e) => setSelectedLessonId(e.target.value)}
              className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            >
              {LESSONS.map((lesson) => (
                <option key={lesson.id} value={lesson.id}>
                  {lesson.title}
                </option>
              ))}
            </select>

            {selectedLesson && (
              <div className="space-y-2 text-sm">
                <p className="text-slate-300">{selectedLesson.description}</p>

                <div className="space-y-2">
                  {selectedLesson.phrases.map((phrase) => {
                    const cacheKey = `${phrase.id}|${fromLang}`;
                    const preview =
                      lessonPreviewCacheRef.current[cacheKey] ??
                      lessonPreviewCache[cacheKey] ??
                      phrase.texts[fromLang] ??
                      phrase.texts["en-US"] ??
                      Object.values(phrase.texts)[0];

                    return (
                      <div
                        key={phrase.id}
                        className="flex items-center gap-2 rounded-md border border-slate-600 bg-slate-900 px-3 py-2"
                      >
                        <div className="text-slate-50 text-sm flex-1 min-w-0">
                          <span className="block truncate">{preview}</span>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void handleUseLessonPhrase(phrase)}
                          className="shrink-0 border-slate-300 text-slate-100 bg-slate-700 hover:bg-slate-600 text-[11px]"
                        >
                          Use this phrase
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
