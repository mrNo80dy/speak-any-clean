"use client";

export function createSignalChannel(_roomId: string) {
  // Minimal no-op channel so builds succeed; replace with Supabase channel later.
  const api = {
    on: () => ({ subscribe: () => ({}) }),
    subscribe: () => ({}),
    unsubscribe: () => {},
    send: (_msg: any) => {},
  };
  return api as any;
}
