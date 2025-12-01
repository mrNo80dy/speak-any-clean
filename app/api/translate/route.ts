// app/api/translate/route.ts
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { from, to, text } = await req.json();

    if (!text || !from || !to) {
      return NextResponse.json(
        { error: "Missing from/to/text" },
        { status: 400 }
      );
    }

    // Map locale-style codes ("en-US") to simple codes ("en")
    const source = from.split("-")[0] || "en";
    const target = to.split("-")[0] || "en";

    const url =
      process.env.LIBRETRANSLATE_URL ??
      "https://libretranslate.de/translate";

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LIBRETRANSLATE_API_KEY
          ? { Authorization: `Bearer ${process.env.LIBRETRANSLATE_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        q: text,
        source,
        target,
        format: "text",
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error("Translate error", res.status, body);
      // Fall back to original text if call fails
      return NextResponse.json(
        { translatedText: text, targetLang: to, error: "upstream-failed" },
        { status: 200 }
      );
    }

    const data = await res.json();
    const translated =
      (data.translatedText as string) ||
      (data.translation as string) ||
      (data.translated as string) ||
      text;

    return NextResponse.json({
      translatedText: translated,
      targetLang: to,
    });
  } catch (err) {
    console.error("Translate route error", err);
    // Generic fallback
    return NextResponse.json(
      { translatedText: "", targetLang: "en-US", error: "route-error" },
      { status: 200 }
    );
  }
}
