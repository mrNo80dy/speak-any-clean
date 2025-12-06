// app/api/translate/route.ts
import { NextResponse } from "next/server";

type TranslateRequestBody = {
  text: string;
  fromLang: string;
  toLang: string;
};

export async function POST(req: Request) {
  let body: TranslateRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { text, fromLang, toLang } = body;

  if (!text || !fromLang || !toLang) {
    return NextResponse.json(
      { error: "Missing text/fromLang/toLang" },
      { status: 400 }
    );
  }

  // Use either OPENAI_API_KEY or NEXT_PUBLIC_OPENAI_API_KEY
  const apiKey =
    process.env.OPENAI_API_KEY || process.env.NEXT_PUBLIC_OPENAI_API_KEY;

  // If no key is set, just echo back the original text (but tell us in error)
  if (!apiKey) {
    console.error("No OpenAI API key configured");
    return NextResponse.json(
      {
        translatedText: text,
        targetLang: toLang,
        error: "Missing OPENAI_API_KEY",
      },
      { status: 200 }
    );
  }

  try {
    const prompt = `Translate the following text from ${fromLang} to ${toLang}.
Only return the translated text, nothing else.

Text:
${text}`;

    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content: "You are a precise, concise translation engine.",
          },
          { role: "user", content: prompt },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("OpenAI error", res.status, errText);
      // Fall back to original text so the UI still works
      return NextResponse.json(
        {
          translatedText: text,
          targetLang: toLang,
          error: `openai_error_${res.status}`,
        },
        { status: 200 }
      );
    }

    const data = await res.json();
    const translated =
      data?.choices?.[0]?.message?.content?.trim() || text;

    return NextResponse.json(
      {
        translatedText: translated,
        targetLang: toLang,
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("translate route exception", err);
    return NextResponse.json(
      {
        translatedText: text,
        targetLang: toLang,
        error: "route_exception",
      },
      { status: 200 }
    );
  }
}
