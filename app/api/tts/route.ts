// app/api/tts/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Body = {
  text?: string;
  voice?: string; // e.g. "alloy" | "ash" | ...
  format?: "mp3" | "wav";
  speed?: number; // optional (only if model supports it)
};

const ALLOWED_VOICES = new Set([
  "alloy",
  "ash",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "ballad",
]);

const MAX_CHARS = 1000;

export async function POST(req: Request) {
  try {
    // ✅ Kill switch (default OFF)
    const enabled = (process.env.TTS_ENABLED || "").toLowerCase() === "true";
    if (!enabled) {
      return NextResponse.json({ error: "TTS is disabled" }, { status: 403 });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const body = (await req.json()) as Body;

    const text = (body.text ?? "").toString().trim();
    if (!text) {
      return NextResponse.json({ error: "Missing 'text'." }, { status: 400 });
    }
    if (text.length > MAX_CHARS) {
      return NextResponse.json(
        { error: `Text too long. Max ${MAX_CHARS} characters.` },
        { status: 400 }
      );
    }

    const voiceRaw = (body.voice ?? "alloy").toString();
    const voice = ALLOWED_VOICES.has(voiceRaw) ? voiceRaw : "alloy";

    const format = body.format === "wav" ? "wav" : "mp3";

    // OpenAI Speech endpoint
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice,
        input: text,
        format,
        // If you later confirm speed is supported on your model, you can pass it:
        // ...(typeof body.speed === "number" ? { speed: body.speed } : {}),
      }),
      cache: "no-store",
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("[tts] OpenAI error:", r.status, errText);
      return NextResponse.json({ error: "TTS request failed." }, { status: 500 });
    }

    const audioBytes = await r.arrayBuffer();

    return new NextResponse(audioBytes, {
      status: 200,
      headers: {
        "Content-Type": format === "wav" ? "audio/wav" : "audio/mpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("[tts] error", err?.message || err);
    return NextResponse.json({ error: "TTS failed." }, { status: 500 });
  }
}
