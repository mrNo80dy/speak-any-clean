export async function translateText(text: string, from: string, to: string): Promise<string> {
  const base = process.env.NEXT_PUBLIC_FUNCTIONS_URL
    || (process.env.NEXT_PUBLIC_SUPABASE_URL ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1` : "");
  const url = `${base}/translate`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Supabase functions accept anon key via Authorization for higher limits, optional:
      Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ""}`,
    },
    body: JSON.stringify({ text, from, to }),
  });

  if (!res.ok) {
    console.warn("translateText HTTP", res.status);
    return text;
  }

  const data = await res.json().catch(() => ({} as any));
  return data?.translatedText ?? text;
}
