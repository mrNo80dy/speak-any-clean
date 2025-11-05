// Supabase Edge Function for translation
// Deploy this to Supabase Edge Functions when ready

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { Deno } from "https://deno.land/std@0.168.0/node/global.ts" // Declare Deno variable

const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY")

serve(async (req) => {
  // Handle CORS
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    })
  }

  try {
    const { text, targetLanguage } = await req.json()

    if (!text || !targetLanguage) {
      return new Response(JSON.stringify({ error: "Missing text or targetLanguage" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    }

    // Call OpenAI API for translation
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `You are a translator. Translate the following text to ${targetLanguage}. Only return the translated text, nothing else.`,
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.3,
      }),
    })

    const data = await response.json()
    const translatedText = data.choices[0]?.message?.content || text

    return new Response(JSON.stringify({ translatedText }), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    })
  }
})
