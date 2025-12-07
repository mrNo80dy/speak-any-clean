// app/api/translate/route.ts
import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { text, fromLang, toLang } = await req.json();

    if (!text || !toLang) {
      return NextResponse.json(
        { error: "Missing 'text' or 'toLang' in request body." },
        { status: 400 }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const systemPrompt =
      "You are a translation engine. You ONLY return the translated text, no explanations or extra words.";

    const userPrompt = `Translate the following text from ${fromLang || "its original language"} to ${toLang}.
Return ONLY the translated text.

Text:
${text}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("OpenAI API error:", response.status, errText);
      return NextResponse.json(
        { error: "OpenAI API request failed." },
        { status: 500 }
      );
    }

    const data = await response.json();

    const content =
      data.choices?.[0]?.message?.content?.toString().trim() || "";

    if (!content) {
      return NextResponse.json(
        { error: "No translation returned from OpenAI." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      translatedText: content,
      targetLang: toLang,
    });
  } catch (err: any) {
    console.error("API /translate error:", err?.message || err);
    return NextResponse.json(
      { error: "Unexpected error in /api/translate." },
      { status: 500 }
    );
  }
}
