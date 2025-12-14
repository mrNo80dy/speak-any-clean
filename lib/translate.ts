// lib/translate.ts
import { type LanguageCode } from "./translation";

/**
 * translateText
 * -------------
 * Called from the client (use-translation.ts).
 * We call our own Next.js API route: /api/translate
 * which uses OpenAI on the server.
 */
export async function translateText(
  text: string,
  sourceLang: LanguageCode,
  targetLang: LanguageCode
): Promise<string> {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // If same language, skip translation
  if (sourceLang === targetLang) {
    return trimmed;
  }

  try {
    const res = await fetch("/api/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: trimmed,
        fromLang: sourceLang,
        toLang: targetLang,
      }),
    });

    if (!res.ok) {
      console.warn("translateText: /api/translate not ok", res.status);
      return trimmed;
    }

    const data = await res.json();

    const translated =
      (data && (data.translatedText as string | undefined)) || "";

    if (!translated.trim()) {
      console.warn("translateText: missing translatedText in response", data);
      return trimmed;
    }

    return translated;
  } catch (error) {
    console.error("translateText error:", error);
    return trimmed;
  }
}
