// app/api/translate/route.ts
import { NextResponse } from "next/server";

const LIBRE_ENDPOINT = "https://libretranslate.de/translate";

// Optional: force this route to always run on the server
export const dynamic = "force-dynamic";

type TranslateBody = {
  text?: string;
  fromLang?: string;
  toLang?: string;
};

function normalizeLang(code?: string): string {
  if (!code) return "en";
  // "en-US" -> "en", "pt-BR" -> "pt"
  return code.split("-")[0].toLowerCase();
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as TranslateBody;
    const rawText = (body.text ?? "").trim();
    const fromLang = body.fromLang || "en-US";
    const toLang = body.toLang || "en-US";

    const displayTargetLang = toLang || fromLang || "en-US";

    const source = normalizeLang(fromLang);
    const target = normalizeLang(toLang);

    const debugBase = {
      rawText,
      fromLang,
      toLang,
      source,
      target,
    };

    // Nothing to translate or same language → just echo.
    if (!rawText || source === target) {
      return NextResponse.json(
        {
          translatedText: rawText,
          targetLang: displayTargetLang,
          debug: {
            ...debugBase,
            reason: "same-lang-or-empty",
            upstreamStatus: null,
            upstreamError: null,
            upstreamRawTranslated: null,
            usedFallback: true,
          },
        },
        { status: 200 }
      );
    }

    const res = await fetch(LIBRE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        q: rawText,
        source,
        target,
        format: "text",
      }),
    });

    if (!res.ok) {
      // Upstream failed → fall back to original text
      return NextResponse.json(
        {
          translatedText: rawText,
          targetLang: displayTargetLang,
          error: "upstream-error",
          debug: {
            ...debugBase,
            reason: "upstream-error",
            upstreamStatus: res.status,
            upstreamError: null,
            upstreamRawTranslated: null,
            usedFallback: true,
          },
        },
        { status: 200 }
      );
    }

    const data = (await res.json()) as {
      translatedText?: string;
      error?: string;
    };

    const maybe = (data.translatedText ?? "").trim();
    const translated =
      maybe.length > 0 && !data.error ? maybe : rawText;

    return NextResponse.json(
      {
        translatedText: translated,
        targetLang: displayTargetLang,
        debug: {
          ...debugBase,
          reason: "ok",
          upstreamStatus: res.status,
          upstreamError: data.error ?? null,
          upstreamRawTranslated: data.translatedText ?? null,
          usedFallback: translated === rawText,
        },
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Translate route error", err);
    return NextResponse.json(
      {
        translatedText: "",
        targetLang: "en-US",
        error: "route-error",
        debug: {
          reason: "route-error",
          errorMessage:
            err instanceof Error ? err.message : String(err),
        },
      },
      { status: 200 }
    );
  }
}
