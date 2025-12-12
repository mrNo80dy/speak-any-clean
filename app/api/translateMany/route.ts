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

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as TranslateManyBody;

    if (!body?.items || !Array.isArray(body.items)) {
      return NextResponse.json(
        { error: "Invalid payload. Expected { items: [...] }" },
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

    // Basic sanitation + guardrails
    const items = body.items
      .map((it, idx) => ({
        id: (it.id ?? String(idx)).toString(),
        text: (it.text ?? "").toString().trim(),
        fromLang: (it.fromLang ?? "").toString(),
        toLang: (it.toLang ?? "").toString(),
      }))
      .filter((it) => it.text.length > 0 && it.fromLang && it.toLang);

    if (items.length === 0) {
      return NextResponse.json({ results: [] satisfies TranslateManyResult[] });
    }

    // If you want, cap to keep prompts sane
    const MAX_ITEMS = 50;
    const sliced = items.slice(0, MAX_ITEMS);

    const systemPrompt =
      "You are a translation engine. Return only valid JSON matching the schema. No extra keys, no commentary.";

    const userPrompt = `Translate each item.text from item.fromLang to item.toLang.
Return results preserving the same id for each item.

items:
${JSON.stringify(sliced, null, 2)}`;

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        // Structured Outputs (JSON schema)
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
        { status: 500 }
      );
    }

    const data = await response.json();

    const content = data?.choices?.[0]?.message?.content?.toString()?.trim() ?? "";
    if (!content) {
      return NextResponse.json(
        { error: "No content returned from OpenAI." },
        { status: 500 }
      );
    }

    let parsed: { results: TranslateManyResult[] } | null = null;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      console.error("[translateMany] JSON parse failed. Content:", content);
      return NextResponse.json(
        { error: "translateMany returned invalid JSON." },
        { status: 500 }
      );
    }

    const results = Array.isArray(parsed?.results) ? parsed!.results : [];
    return NextResponse.json({ results }, { status: 200 });
  } catch (err: any) {
    console.error("[translateMany] error", err?.message || err);
    return NextResponse.json(
      { error: "translateMany failed" },
      { status: 500 }
    );
  }
}
