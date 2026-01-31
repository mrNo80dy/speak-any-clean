// app/api/stt/route.ts
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500 }
      );
    }

    const form = await req.formData();
    const file = form.get("file");
    const lang = (form.get("lang") as string | null) || "en-US";

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { error: "Missing audio file (field: file)." },
        { status: 400 }
      );
    }

    const fd = new FormData();
    fd.append("file", file, "audio.webm");
    fd.append("model", "whisper-1");
    const base = (lang || "").slice(0, 2).toLowerCase();
    if (base) fd.append("language", base);

    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd as any,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("OpenAI STT error:", r.status, errText);

      // IMPORTANT: bubble details to client debug (truncated)
      return NextResponse.json(
        {
          error: "OpenAI STT request failed.",
          openai_status: r.status,
          detail: errText.slice(0, 800),
        },
        { status: 500 }
      );
    }

    const data: any = await r.json().catch(() => null);
    const text = (data?.text as string | undefined) || "";
    return NextResponse.json({ text: text.trim() });
  } catch (err: any) {
    console.error("API /stt error:", err?.message || err);
    return NextResponse.json(
      { error: "Unexpected error in /api/stt.", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}
