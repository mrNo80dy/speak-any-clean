"use client";

import { useEffect, useRef, useState } from "react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { LANGUAGES, type LanguageConfig } from "@/lib/languages";

type TranslateResponse = {
  translatedText?: string;
  targetLang?: string;
  error?: string;
};

type LessonPhrase = {
  id: string;
  texts: Record<string, string>;
};

type Lesson = {
  id: string;
  title: string;
  description: string;
  phrases: LessonPhrase[];
};

const LESSONS: Lesson[] = [
  {
    id: "introductions",
    title: "Introductions",
    description:
      "Simple ways to say who you are and ask about the other person.",
    phrases: [
      {
        id: "intro-1",
        texts: {
          "en-US": "Hi, my name is Chad.",
          "pt-BR": "Oi, meu nome é Chad.",
        },
      },
      {
        id: "intro-2",
        texts: {
          "en-US": "Nice to meet you.",
          "pt-BR": "Prazer em te conhecer.",
        },
      },
      {
        id: "intro-3",
        texts: {
          "en-US": "Where are you from?",
          "pt-BR": "De onde você é?",
        },
      },
    ],
  },
  {
    id: "travel-basics",
    title: "Travel – basics",
    description: "Useful phrases for getting around and asking for help.",
    phrases: [
      {
        id: "travel-1",
        texts: {
          "en-US": "Excuse me, where is the bathroom?",
          "pt-BR": "Com licença, onde fica o banheiro?",
        },
      },
      {
        id: "travel-2",
        texts: {
          "en-US": "How much does this cost?",
          "pt-BR": "Quanto custa isso?",
        },
      },
      {
        id: "travel-3",
        texts: {
          "en-US": "Can you help me, please?",
          "pt-BR": "Você pode me ajudar, por favor?",
        },
      },
    ],
  },
];

async function translateText(
  fromLang: string,
  toLang: string,
  text: string
): Promise<{ translatedText: string; targetLang: string }> {
  const trimmed = text.trim();
  if (!trimmed) {
    return { translatedText: "", targetLang: toLang };
  }

  if (fromLang === toLang) {
    return { translatedText: trimmed, targetLang: toLang };
  }

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

    return {
      translatedText: data.translatedText,
      targetLang: data.targetLang || toLang,
    };
  } catch (err) {
    console.error("[Learn] translate API failed", err);
    return { translatedText: trimmed, targetLang: toLang };
  }
}

function speakText(text: string, lang: string) {
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
      let voice =
        voices.find(
          (v) => v.lang.toLowerCase() === lang.toLowerCase()
        ) ??
        voices.find((v) =>
          v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())
        );

      if (voice) {
        utterance.voice = voice;
      }
    }

    utterance.lang = lang || "en-US";
    utterance.rate = 1.0;
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
    if (aWords[i] && bWords[i] && aWords[i] === bWords[i]) {
      matches++;
    }
  }

  return Math.round((matches / maxLen) * 100);
}

export default function LearnPage() {
  const [fromLang, setFromLang] = useState("en-US");
  const [toLang, setToLang] = useState("pt-BR");

  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [attemptText, setAttemptText] = useState("");
  const [attemptScore, setAttemptScore] = useState<number | null>(null);

  const [isRecordingSource, setIsRecordingSource] = useState(false);
  const [isRecordingAttempt, setIsRecordingAttempt] = useState(false);
  const [sttSupported, setSttSupported] = useState<boolean | null>(null);

  const sourceRecRef = useRef<any>(null);
  const attemptRecRef = useRef<any>(null);

  const [selectedLessonId, setSelectedLessonId] =
    useState<string>("introductions");

  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as any;
    const SpeechRecognitionCtor =
      w.SpeechRecognition || w.webkitSpeechRecognition;

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
      const text = raw.trim();
      setSourceText(text);
      setIsRecordingSource(false);
    };

    srcRec.onerror = (event: any) => {
      console.error("[Learn] source STT error", event.error);
      setError(event.error || "Speech recognition error.");
      setIsRecordingSource(false);
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

      if (translatedText) {
        setAttemptScore(scoreSimilarity(translatedText, text));
      }
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

  async function handleTranslate() {
    setError(null);
    setLoading(true);
    setAttemptText("");
    setAttemptScore(null);

    try {
      const { translatedText } = await translateText(
        fromLang,
        toLang,
        sourceText
      );
      setTranslatedText(translatedText);
    } catch (err: any) {
      console.error("[Learn] translate error", err);
      setError(err?.message || "Unexpected error in Learn translate.");
    } finally {
      setLoading(false);
    }
  }

  function handlePlaySource() {
    speakText(sourceText, fromLang);
  }

  function handlePlayTarget() {
    speakText(translatedText, toLang);
  }

  function handleStartSourceRecord() {
    setError(null);
    if (!sttSupported || !sourceRecRef.current) {
      setError(
        "Speech input isn’t supported on this device. You can still type and translate."
      );
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
      setError(
        "Speech practice isn’t supported on this device. You can still listen and repeat."
      );
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

  const selectedLesson = LESSONS.find((l) => l.id === selectedLessonId);

  function handleUseLessonPhrase(phrase: LessonPhrase) {
    setError(null);
    setAttemptText("");
    setAttemptScore(null);

    const textForFromLang =
      phrase.texts[fromLang] ??
      phrase.texts["en-US"] ??
      Object.values(phrase.texts)[0];

    setSourceText(textForFromLang);

    setTimeout(() => {
      handleTranslate();
    }, 0);
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-900 text-slate-100 px-4 py-4">
      <Card className="w-full max-w-xl md:max-w-2xl bg-slate-800 border border-slate-400 shadow-2xl flex flex-col">
        <CardHeader className="pb-2">
          <div className="text-center">
            <h2 className="text-2xl font-bold text-white">
              Any-Speak Learn
            </h2>
            <p className="text-xs md:text-sm text-slate-200 mt-1">
            Type or speak in your language, hear it in another, then practice saying it.
            </p>
          </div>
        </CardHeader>

        <CardContent className="space-y-3 px-5 pb-3">
          {/* Language selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-slate-100">
                From language
              </Label>
              <select
                value={fromLang}
                onChange={(e) => setFromLang(e.target.value)}
                className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-xs md:text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LANGUAGES.map((lang: LanguageConfig) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-slate-100">
                To language
              </Label>
              <select
                value={toLang}
                onChange={(e) => setToLang(e.target.value)}
                className="w-full rounded-md border border-slate-500 bg-slate-900 px-3 py-1.5 text-xs md:text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LANGUAGES.map((lang: LanguageConfig) => (
                  <option key={lang.code} value={lang.code}>
                    {lang.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Source text + source voice button */}
         <div className="flex items-center justify-between">
  <Label className="text-xs text-slate-100">Your sentence</Label>
</div>

<div className="relative">
  <Textarea
    rows={3}
    value={sourceText}
    onChange={(e) => setSourceText(e.target.value)}
    placeholder="Type or speak what you want to say…"
    className="bg-slate-900 border border-slate-500 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 pr-24"
  />
  <Button
    size="sm"
    variant="outline"
    onClick={handleStartSourceRecord}
    disabled={isRecordingSource}
    className="absolute top-2 right-2 border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-[11px]"
  >
    {isRecordingSource ? "Listening…" : "Speak instead"}
  </Button>
</div>


          {/* Translate + play buttons */}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={handleTranslate}
              disabled={loading || !sourceText.trim()}
              className="bg-emerald-500 hover:bg-emerald-400 text-slate-900 font-semibold disabled:opacity-60 text-sm"
            >
              {loading ? "Translating…" : "Translate"}
            </Button>
            <Button
              variant="outline"
              onClick={handlePlaySource}
              disabled={!sourceText.trim()}
              className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-sm"
            >
              Play original
            </Button>
            <Button
              variant="outline"
              onClick={handlePlayTarget}
              disabled={!translatedText.trim()}
              className="border-slate-200 text-slate-50 bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-sm"
            >
              Play translation
            </Button>
          </div>

          {error && (
            <div className="text-[11px] text-red-200">
              {error === "not-allowed"
                ? "Mic access was blocked by the browser. Check the microphone permission if you want to use speach input."
                : error}
            </div>
          )}

          {sttWarning && (
            <div className="text-[11px] text-amber-200">
              {sttWarning}
            </div>
          )}

          {/* Translated text */}
          <div className="space-y-1">
            <Label className="text-xs text-slate-100">
              Translated sentence
            </Label>
            <div className="min-h-[2.5rem] rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-sm text-slate-50">
              {translatedText || (
                <span className="text-slate-400">
                  Translate a sentence to see it here.
                </span>
              )}
            </div>
          </div>

          {/* Practice section */}
          <div className="space-y-2 border-t border-slate-600 pt-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm text-slate-100">
                Practice speaking the translation
              </Label>
              <Button
                size="sm"
                onClick={handleStartAttemptRecord}
                disabled={!translatedText.trim() || isRecordingAttempt}
                className="bg-blue-500 hover:bg-blue-400 text-slate-900 font-semibold disabled:opacity-60 text-[11px]"
              >
                {isRecordingAttempt ? "Listening…" : "Record my attempt"}
              </Button>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-slate-300">
                What you said (recognized)
              </Label>
              <div className="min-h-[2.5rem] rounded-md border border-slate-500 bg-slate-900 px-3 py-2 text-sm text-slate-50">
                {attemptText || (
                  <span className="text-slate-400">
                    After recording, your attempt will appear here in the target
                    language.
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-[11px] text-slate-300">
                Accuracy (rough estimate)
              </Label>
              <div className="text-sm text-slate-50">
                {attemptScore === null ? (
                  <span className="text-slate-400">
                    You&apos;ll see a score after an attempt.
                  </span>
                ) : (
                  <span>{attemptScore}% match to the ideal sentence.</span>
                )}
              </div>
            </div>
          </div>

          {/* Lesson mode */}
          <div className="space-y-2 border-t border-slate-600 pt-2 pb-1">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm text-slate-100">
                Lesson mode (guided phrases)
              </Label>
              <select
                value={selectedLessonId}
                onChange={(e) => setSelectedLessonId(e.target.value)}
                className="rounded-md border border-slate-500 bg-slate-900 px-2 py-1 text-[11px] text-slate-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                {LESSONS.map((lesson) => (
                  <option key={lesson.id} value={lesson.id}>
                    {lesson.title}
                  </option>
                ))}
              </select>
            </div>

            {selectedLesson && (
              <div className="space-y-2 text-xs md:text-sm">
                <p className="text-slate-300">{selectedLesson.description}</p>

                <div className="space-y-2">
                  {selectedLesson.phrases.map((phrase) => {
  const preview =
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
        onClick={() => handleUseLessonPhrase(phrase)}
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
