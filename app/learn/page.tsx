"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { LANGUAGES, type LanguageConfig } from "@/lib/languages";

type TranslateResponse = {
  translatedText?: string;
  targetLang?: string;
  error?: string;
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

function pickSupportedLang(code: string, fallback: string) {
  const has = LANGUAGES.some((l) => l.code === code);
  if (has) return code;

  // Try base language match: pt-BR -> pt-PT style or vice versa
  const base = code.slice(0, 2).toLowerCase();
  const
