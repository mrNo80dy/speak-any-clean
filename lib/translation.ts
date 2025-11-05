// Translation service that calls the Supabase Edge Function
export async function translateText(text: string, targetLanguage: string): Promise<string> {
  try {
    const edgeFunctionUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/translate-text`
      : null

    if (!edgeFunctionUrl) {
      console.warn("[v0] Translation service not configured. Returning original text.")
      return `[${targetLanguage.toUpperCase()}] ${text}`
    }

    const response = await fetch(edgeFunctionUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ text, targetLanguage }),
    })

    const data = await response.json()
    return data.translatedText || text
  } catch (error) {
    console.error("[v0] Translation error:", error)
    return text
  }
}

// Language options
export const LANGUAGES = [
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "it", name: "Italian" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "hi", name: "Hindi" },
] as const

export type LanguageCode = (typeof LANGUAGES)[number]["code"]
