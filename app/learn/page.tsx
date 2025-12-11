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

type TranslateResponse = {
  translatedText?: string;
  targetLang?: string;
  error?: string;
};

/**
 * Shared translator: calls /api/translate with { text, fromLang, toLang }.
 */
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

/**
 * TTS helper with a simple "wait for voices to load" fix
 * so the first playback isn't chopped.
 */
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
    } catch {
      // ignore
    }

    const utterance = new SpeechSynthesisUtterance(trimmed);
    const voices = synth.getVoices();

    console.log(
      "[Learn] available voices:",
      voices?.map((v) => `${v.lang} - ${v.name}`)
    );

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
        console.log(
          "[Learn] using voice:",
          voice.lang,
          "|",
          voice.name
        );
      }
    }

    utterance.lang = lang || "en-US";
    utterance.rate = 1.0;
    synth.speak(utterance);
  };

  const currentVoices = synth.getVoices();
  if (!currentVoices || currentVoices.length === 0) {
    console.log("[Learn] voices not ready yet, waiting…");
    synth.onvoiceschanged = () => {
      synth.onvoiceschanged = null;
      doSpeak();
    };
    return;
  }

  doSpeak();
}

/**
 * Very simple similarity score between two sentences (0–100).
 * Later we can upgrade this to phoneme-level scoring; for now,
 * this is enough to give people feedback.
 */
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
  const [isRecording, setIsRecording] = useState(false);
  const recognitionRef = useRef<any>(null);

  // Set up a simple SpeechRecognition instance for attempts
  useEffect(() => {
    if (typeof window === "undefined") return;

    const w = window as any;
    const SpeechRecognitionCtor =
      w.SpeechRecognition || w.webkitSpeechRecognition;

    if (!SpeechRecognitionCtor) {
      console.warn("[Learn] SpeechRecognition not supported on this device");
      return;
    }

    const rec = new SpeechRecognitionCtor();
    rec.continuous = false;
    rec.interimResults = false;
    rec.lang = toLang;

    rec.onresult = (event: any) => {
      const results = event.results;
      if (!results || results.length === 0) return;
      const last = results[results.length - 1];
      const raw = last[0]?.transcript || "";
      const text = raw.trim();
      console.log("[Learn] attempt result:", text);
      setAttemptText(text);

      if (translatedText) {
        setAttemptScore(scoreSimilarity(translatedText, text));
      }
    };

    rec.onerror = (event: any) => {
      console.error("[Learn] STT error", event.error);
      setError(event.error || "Speech recognition error.");
      setIsRecording(false);
    };

    rec.onend = () => {
      setIsRecording(false);
    };

    recognitionRef.current = rec;

    return () => {
      try {
        rec.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    };
  }, [toLang, translatedText]);

  async function handleTranslate() {
    setError(null);
    setLoading(true);
    setAttemptText("");
    setAttemptScore(null);

    try {
      const { translatedText, targetLang } = await translateText(
        fromLang,
        toLang,
        sourceText
      );
      console.log("[Learn] translate result", { translatedText, targetLang });
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

  function handleStartAttempt() {
    setError(null);
    if (!recognitionRef.current) {
      setError(
        "This device/browser does not support speech recognition for practice."
      );
      return;
    }
    try {
      setIsRecording(true);
      setAttemptText("");
      setAttemptScore(null);
      recognitionRef.current.lang = toLang;
      recognitionRef.current.start();
    } catch (err) {
      console.error("[Learn] start attempt error", err);
      setIsRecording(false);
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-slate-950 text-slate-100 p-4">
      <Card className="w-full max-w-xl md:max-w-2xl bg-slate-900 border-slate-700 shadow-xl">
        <CardHeader>
          <CardTitle className="flex flex-col gap-1">
            <span className="text-lg md:text-xl">Any-Speak Learn</span>
            <span className="text-xs text-slate-400">
              Build a sentence in your language, hear it in another, then
              practice speaking it.
            </span>
          </CardTitle>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* Language selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="fromLang">From language</Label>
              <select
                id="fromLang"
                value={fromLang}
                onChange={(e) => setFromLang(e.target.value)}
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="en-US">English (US)</option>
                <option value="pt-BR">Português (Brasil)</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="toLang">To language</Label>
              <select
                id="toLang"
                value={toLang}
                onChange={(e) => setToLang(e.target.value)}
                className="w-full rounded-md border border-slate-600 bg-slate-900 px-3 py-2 text-sm"
              >
                <option value="pt-BR">Português (Brasil)</option>
                <option value="en-US">English (US)</option>
              </select>
            </div>
          </div>

          {/* Source text */}
          <div className="space-y-1">
            <Label htmlFor="sourceText">Your sentence</Label>
            <Textarea
              id="sourceText"
              rows={3}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="Type what you want to say…"
            />
          </div>

          {/* Translate + play buttons */}
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleTranslate} disabled={loading}>
              {loading ? "Translating…" : "Translate"}
            </Button>
            <Button
              variant="outline"
              onClick={handlePlaySource}
              disabled={!sourceText}
            >
              Play original
            </Button>
            <Button
              variant="outline"
              onClick={handlePlayTarget}
              disabled={!translatedText}
            >
              Play translation
            </Button>
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-400">Error: {error}</div>
          )}

          {/* Translated text */}
          <div className="space-y-1">
            <Label>Translated sentence</Label>
            <div className="min-h-[3rem] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
              {translatedText || (
                <span className="text-slate-500">
                  Translate a sentence to see it here.
                </span>
              )}
            </div>
          </div>

          {/* Practice section */}
          <div className="space-y-2 border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-sm">Practice speaking the translation</Label>
              <Button
                size="sm"
                onClick={handleStartAttempt}
                disabled={!translatedText || isRecording}
              >
                {isRecording ? "Listening…" : "Record my attempt"}
              </Button>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-slate-400">
                What you said (recognized)
              </Label>
              <div className="min-h-[2.5rem] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm">
                {attemptText || (
                  <span className="text-slate-500">
                    Tap &quot;Record my attempt&quot; and speak in the target
                    language.
                  </span>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs text-slate-400">
                Accuracy (rough estimate)
              </Label>
              <div className="text-sm">
                {attemptScore === null ? (
                  <span className="text-slate-500">
                    You&apos;ll see a score after an attempt.
                  </span>
                ) : (
                  <span>
                    {attemptScore}% match to the ideal sentence.
                  </span>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
