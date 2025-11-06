// lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Reuse the same client across the browser session
export const supabase =
  (typeof window !== 'undefined' && (window as any).__ANY_SPEAK_SB__)
    ? (window as any).__ANY_SPEAK_SB__
    : createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
          persistSession: false,             // you’re not using auth yet
          storageKey: 'any-speak-auth',      // avoid key collisions across clients
        },
        realtime: { params: { eventsPerSecond: 25 } },
      });

if (typeof window !== 'undefined') {
  (window as any).__ANY_SPEAK_SB__ = supabase;
}
