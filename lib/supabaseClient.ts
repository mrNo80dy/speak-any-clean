"use client";

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Fail fast (helps avoid mysterious 404/401 at runtime)
if (!url || !anon) {
  // Throw only on client to avoid SSR crash loops
  if (typeof window !== "undefined") {
    throw new Error(
      "[supabase] Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. " +
      "Set them in Vercel → Project → Settings → Environment Variables."
    );
  }
}

if (typeof window !== "undefined") {
  console.log("[supabase] URL:", url);
  console.log("[supabase] ANON length:", (anon || "").length);
}

export const supabase = createClient(url!, anon!, {
  auth: { persistSession: false, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
});
