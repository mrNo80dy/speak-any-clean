// app/api/translate/route.ts
import { NextRequest, NextResponse } from "next/server";

type TranslateBody = {
  text?: string;
  fromLang?: string;
  toLang?: string;
  from?: string;
  to?: string;
};

// Map "en-US" → "en", "pt-BR" → "pt", etc.
// LibreTranslate understands 2-letter codes.
function normalizeLang(code?: string | null): string | null {
  if (!code) return null;

  const lower = code.toLowerCase();

  if (lower.startsWith("en")) return "en";
  if (lower.startsWith("pt")) return "pt";
  if (lower.startsWith("es")) return "es";
  if (lower.startsWith("fr")) return "fr";
  if (lower.startsWith("de")) return "de";
  if (lower.startsWith("it")) return "it";

  // Fallback: if it’s already 2 letters, use as-is
  if (lower.length === 2) return lower;

  return null;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as TranslateBody;

    const text = (body.text || "").trim();
    if (!text) {
      return NextResponse.json(
        { error: "Missing text" },
        { status: 400 }
      );
    }

    // Support both {fromLang,toLang} and {from,to}
    const fromInput = body.fromLang ?? body.from ?? null;
    const toInput = body.toLang ?? body.to ?? null;

    const source = normalizeLang(fromInput) ?? "auto";
    const target = normalizeLang(toInput) ?? "en";

    // If source and target are the same (and not "auto"), just echo
    if (source !== "auto" && source === target) {
      return NextResponse.json({
        translatedText: text,
        targetLang: target,
        detectedSourceLang: source,
      });
    }

    // Call LibreTranslate (public instance).
    // NOTE: This is just to get you moving; later we’ll swap to your own
    // self-hosted or paid provider.
    const apiRes = await fetch("https://libretranslate.de/translate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // No auth key for this free public instance.
      },
      body: JSON.stringify({
        q: text,
        source,       // "auto" or language code
        target,       // language code like "en" / "pt"
        format: "text",
      }),
    });

    if (!apiRes.ok) {
      console.error("LibreTranslate error status", apiRes.status);
      return NextResponse.json(
        {
          translatedText: text, // fallback: original
          targetLang: target,
          error: `LibreTranslate status ${apiRes.status}`,
        },
        { status: 200 }
      );
    }

    const data = await apiRes.json();

    // LibreTranslate returns { translatedText: "..." }
    const translated =
      (data?.translatedText as string | undefined) ||
      (data?.translated as string | undefined) ||
      "";

    if (!translated.trim()) {
      console.warn("LibreTranslate: empty translated text", data);
      return NextResponse.json({
        translatedText: text, // fallback
        targetLang: target,
        detectedSourceLang: data?.detectedLanguage?.language ?? source,
      });
    }

    return NextResponse.json({
      translatedText: translated.trim(),
      targetLang: target,
      detectedSourceLang: data?.detectedLanguage?.language ?? source,
    });
  } catch (err) {
    console.error("translate route fatal error", err);
    return NextResponse.json(
      {
        translatedText: "",
        targetLang: "en",
        error: "Internal translation error",
      },
      { status: 500 }
    );
  }
}
