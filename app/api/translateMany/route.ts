// app/api/translateMany/route.ts
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type TranslateManyItem = {
  id?: string;
  text: string;
  fromLang: string;
  toLang: string;
};

type TranslateManyBody = {
  items: TranslateManyItem[];
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as TranslateManyBody;

    if (!body?.items || !Array.isArray(body.items)) {
      return NextResponse.json(
        { error: "Invalid payload. Expected { items: [...] }" },
        { status: 400 }
      );
    }

    // Build absolute URL to your existing /api/translate endpoint
    const translateUrl = new URL("/api/translate", req.url);

    const results = await Promise.all(
      body.items.map(async (item, idx) => {
        const id = item.id ?? String(idx);
        const text = (item.text ?? "").trim();
        const fromLang = item.fromLang;
        const toLang = item.toLang;

        if (!text) return { id, translatedText: "", targetLang: toLang };
        if (!fromLang || !toLang) return { id, translatedText: text, targetLang: toLang || fromLang };
        if (fromLang === toLang) return { id, translatedText: text, targetLang: toLang };

        try {
          const r = await fetch(translateUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, fromLang, toLang }),
            cache: "no-store",
            next: { revalidate: 0 },
          });

          if (!r.ok) {
            return { id, translatedText: text, targetLang: toLang };
          }

          const data = (await r.json()) as {
            translatedText?: string;
            targetLang?: string;
          };

          return {
            id,
            translatedText: data?.translatedText ?? text,
            targetLang: data?.targetLang ?? toLang,
          };
        } catch {
          return { id, translatedText: text, targetLang: toLang };
        }
      })
    );

    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("[translateMany] error", err);
    return NextResponse.json({ error: "translateMany failed" }, { status: 500 });
  }
}
