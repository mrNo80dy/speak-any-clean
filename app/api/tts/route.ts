import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type Body = {
  text?: string;
  voice?: string;   // e.g. "alloy" | "ash" | "coral" | "echo" | "sage" | "shimmer" | "verse" | "ballad"
  format?: "mp3" | "wav";
  speed?: number;   // optional, depends on model support
};

export async function POST(req: Request) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const body = (await req.json()) as Body;
    const text = (body.text ?? "").toString().trim();
    const voice = (body.voice ?? "alloy").toString();
    const format = body.format ?? "mp3";

    if (!text) {
      return NextResponse.json({ error: "Missing 'text'." }, { status: 400 });
    }

    // OpenAI Speech endpoint
    const r = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts", // if your account uses a different TTS model, swap it here
        voice,
        input: text,
        format,
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
