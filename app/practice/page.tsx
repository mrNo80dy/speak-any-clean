"use client";

import { useState } from "react";
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
 * Uses the same /api/translate route as RoomCall.
 * If anything fails, we fall back to the original text.
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

  // If languages match, no translation needed.
  if (fromLang === toLang) {
    return { translatedText: trimmed, targetLang: toLang };
  }

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: trimmed,
        fromLang,
        toLang,
      }),
    });

    if (!res.ok) {
      console.error("[Practice] translate API not ok", res.status);
      return { translatedText: trimmed, targetLang: toLang };
    }

    const data: TranslateResponse = await res.json();

    if (!data || !data.translatedText) {
      console.warn("[Practice] translate API missing translatedText", data);
      return { translatedText: trimmed, targetLang: toLang };
    }

    return {
      translatedText: data.translatedText,
      targetLang: data.targetLang || toLang,
    };
  } catch (err) {
    console.error("[Practice] translate API failed", err);
    return { translatedText: trimmed, targetLang: toLang };
  }
}

/**
 * Simple wrapper around browser speechSynthesis.
 * Same behavior pattern as in RoomCall.
 */
function speakText(text: string, lang: string) {
  if (typeof window === "undefined") return;

  const synth = window.speechSynthesis;
  if (!synth) {
    console.warn("[Practice] speechSynthesis not available");
    return;
  }

  const trimmed = text.trim();
  if (!trimmed) return;

  console.log("[Practice] 🔊 speakText called:", { text: trimmed, lang });

  try {
    synth.cancel();
  } catch {
    // ignore
  }

  const utterance = new SpeechSynthesisUtterance(trimmed);

  const voices = synth.getVoices();
  console.log(
    "[Practice] available voices:",
    voices?.map((v) => `${v.lang} - ${v.name}`)
  );

  if (voices && voices.length > 0) {
    let voice =
      voices.find((v) => v.lang.toLowerCase() === lang.toLowerCase()) ??
      voices.find((v) =>
        v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase())
      );

    if (voice) {
      utterance.voice = voice;
      console.log(
        "[Practice] using voice:",
        voice.lang,
        "|",
        voice.name
      );
    }
  }

  utterance.lang = lang || "en-US";
  utterance.rate = 1.0;
  synth.speak(utterance);
}

export default function PracticePage() {
  const [fromLang, setFromLang] = useState("en-US");
  const [toLang, setToLang] = useState("pt-BR");

  const [sourceText, setSourceText] = useState("");
  const [translatedText, setTranslatedText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTranslateAndSpeak() {
    setError(null);
    setLoading(true);
    try {
      console.log("[Practice] translating", { fromLang, toLang, sourceText });

      const { translatedText, targetLang } = await translateText(
        fromLang,
        toLang,
        sourceText
      );

      console.log("[Practice] result", { translatedText, targetLang });
      setTranslatedText(translatedText);

      if (translatedText) {
        speakText(translatedText, targetLang || toLang);
      }
    } catch (err: any) {
      console.error("[Practice] unexpected error", err);
      setError(err?.message || "Unexpected error in practice translator.");
    } finally {
      setLoading(false);
    }
  }

  function handleSpeakOriginal() {
    speakText(sourceText, fromLang);
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-50 p-4">
      <Card className="w-full max-w-2xl bg-slate-900/80 border-slate-700 shadow-xl">
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Translation + TTS Practice</span>
            <span className="text-xs text-slate-400">
              Debug: /api/translate + speechSynthesis
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
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
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
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
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
              rows={4}
              value={sourceText}
              onChange={(e) => setSourceText(e.target.value)}
              placeholder="Type a sentence in your language here…"
            />
          </div>

          {/* Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button onClick={handleTranslateAndSpeak} disabled={loading}>
              {loading ? "Translating..." : "Translate + Speak Target"}
            </Button>
            <Button
              variant="outline"
              onClick={handleSpeakOriginal}
              disabled={!sourceText}
            >
              Speak Original Only
            </Button>
          </div>

          {/* Error */}
          {error && (
            <div className="text-sm text-red-400">
              Error: {error}
            </div>
          )}

          {/* Result */}
          <div className="space-y-1">
            <Label>Translated text (debug)</Label>
            <div className="min-h-[3rem] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100">
              {translatedText || (
                <span className="text-slate-500">None yet</span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
