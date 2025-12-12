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

type TranslateManyResult = {
  id: string;
  translatedText: string;
  targetLang: string;
};

type OpenAITranslateManyResponse = {
  results: TranslateManyResult[];
};

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as TranslateManyBody;

    if (!body?.items || !Array.isArray(body.items)) {
      return NextResponse.json(
        { error: "Invalid payload. Expected { items: [...] }" },
        { status: 400, headers: { "Cache-Control": "no-store" } }
      );
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "OPENAI_API_KEY is not set on the server." },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Sanitize + keep ids stable
    const cleaned = body.items
      .map((it, idx) => ({
        id: (it.id ?? String(idx)).toString(),
        text: (it.text ?? "").toString().trim(),
        fromLang: (it.fromLang ?? "").toString(),
        toLang: (it.toLang ?? "").toString(),
      }))
      .map((it) => {
        // If missing critical fields, treat as passthrough
        if (!it.text) {
          return { ...it, translatedText: "", targetLang: it.toLang || it.fromLang };
        }
        if (!it.fromLang || !it.toLang) {
          return { ...it, translatedText: it.text, targetLang: it.toLang || it.fromLang };
        }
        if (it.fromLang === it.toLang) {
          return { ...it, translatedText: it.text, targetLang: it.toLang };
        }
        return it;
      });

    // Split into: already done vs needs translation
    const passthrough: TranslateManyResult[] = [];
    const needsTranslate: { id: string; text: string; fromLang: string; toLang: string }[] = [];

    for (const it of cleaned) {
      const maybe = it as any;
      if (typeof maybe.translatedText === "string" && typeof maybe.targetLang === "string") {
        passthrough.push({
          id: it.id,
          translatedText: maybe.translatedText,
          targetLang: maybe.targetLang,
        });
      } else {
        needsTranslate.push({
          id: it.id,
          text: it.text,
          fromLang: it.fromLang,
          toLang: it.toLang,
        });
      }
    }

    if (needsTranslate.length === 0) {
      // nothing to do
      return NextResponse.json(
        { results: passthrough },
        { status: 200, headers: { "Cache-Control": "no-store" } }
      );
    }

    // Cap so prompts don’t get insane
    const MAX_ITEMS = 50;
    const sliced = needsTranslate.slice(0, MAX_ITEMS);

    const systemPrompt =
      "You are a translation engine. Output must be valid JSON that matches the provided schema. No commentary.";

    const userPrompt = `Translate each item.text from item.fromLang to item.toLang.
Return results preserving the same id for each item.

items:
${JSON.stringify(sliced)}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "translate_many",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                results: {
                  type: "array",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      id: { type: "string" },
                      translatedText: { type: "string" },
                      targetLang: { type: "string" },
                    },
                    required: ["id", "translatedText", "targetLang"],
                  },
                },
              },
              required: ["results"],
            },
          },
        },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
      cache: "no-store",
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("[translateMany] OpenAI error:", response.status, errText);
      return NextResponse.json(
        { error: "OpenAI API request failed." },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content?.toString()?.trim() ?? "";

    if (!content) {
      return NextResponse.json(
        { error: "No content returned from OpenAI." },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    let parsed: OpenAITranslateManyResponse;
    try {
      parsed = JSON.parse(content) as OpenAITranslateManyResponse;
    } catch (e) {
      console.error("[translateMany] JSON parse failed. Content:", content);
      return NextResponse.json(
        { error: "translateMany returned invalid JSON." },
        { status: 500, headers: { "Cache-Control": "no-store" } }
      );
    }

    const translated = Array.isArray(parsed?.results) ? parsed.results : [];

    // Merge passthrough + translated, preserving original request order when possible
    const map = new Map<string, TranslateManyResult>();
    for (const r of [...passthrough, ...translated]) map.set(r.id, r);

    const ordered: TranslateManyResult[] = cleaned.map((it) => {
      const r = map.get(it.id);
      if (r) return r;
      // fallback (shouldn’t happen, but don’t crash)
      return { id: it.id, translatedText: it.text ?? "", targetLang: it.toLang || it.fromLang };
    });

    return NextResponse.json(
      { results: ordered },
      { status: 200, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    console.error("[translateMany] error", err?.message || err);
    return NextResponse.json(
      { error: "translateMany failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } }
    );
  }
}
