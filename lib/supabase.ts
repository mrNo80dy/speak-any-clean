import { createBrowserClient } from "@supabase/ssr"

// Supabase client singleton
let supabaseInstance: ReturnType<typeof createBrowserClient> | null = null

export function getSupabase() {
  if (supabaseInstance) return supabaseInstance

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn("[v0] Supabase credentials not found. Using mock mode.")
    // Return a mock client for development without Supabase
    return createMockSupabaseClient()
  }

  supabaseInstance = createBrowserClient(supabaseUrl, supabaseAnonKey)
  return supabaseInstance
}

// Mock Supabase client for development without backend
function createMockSupabaseClient() {
  const mockData = {
    rooms: [] as any[],
    participants: [] as any[],
    signaling: [] as any[],
  }

  return {
    from: (table: string) => ({
      insert: async (data: any) => {
        const id = crypto.randomUUID()
        const record = { ...data, id, created_at: new Date().toISOString() }
        mockData[table as keyof typeof mockData]?.push(record)
        return { data: record, error: null }
      },
      select: (columns?: string) => ({
        eq: (column: string, value: any) => ({
          single: async () => {
            const record = mockData[table as keyof typeof mockData]?.find((r) => r[column] === value)
            return { data: record || null, error: null }
          },
          then: async (resolve: any) => {
            const records = mockData[table as keyof typeof mockData]?.filter((r) => r[column] === value)
            resolve({ data: records || [], error: null })
          },
        }),
        then: async (resolve: any) => {
          resolve({ data: mockData[table as keyof typeof mockData] || [], error: null })
        },
      }),
      delete: () => ({
        eq: async (column: string, value: any) => {
          const arr = mockData[table as keyof typeof mockData]
          if (arr) {
            const index = arr.findIndex((r) => r[column] === value)
            if (index > -1) arr.splice(index, 1)
          }
          return { error: null }
        },
      }),
    }),
    channel: (name: string) => ({
      on: (event: string, filter: any, callback: Function) => ({
        subscribe: () => {
          console.log(`[v0] Mock: Subscribed to ${name} - ${event}`)
          return { unsubscribe: () => {} }
        },
      }),
    }),
  } as any
}

export type Database = {
  public: {
    Tables: {
      rooms: {
        Row: {
          id: string
          name: string
          created_at: string
        }
        Insert: {
          id?: string
          name: string
          created_at?: string
        }
      }
      participants: {
        Row: {
          id: string
          room_id: string
          peer_id: string
          language: string
          joined_at: string
        }
        Insert: {
          id?: string
          room_id: string
          peer_id: string
          language?: string
          joined_at?: string
        }
      }
      signaling: {
        Row: {
          id: string
          room_id: string
          from_peer: string
          to_peer: string
          signal_type: string
          signal_data: any
          created_at: string
        }
        Insert: {
          id?: string
          room_id: string
          from_peer: string
          to_peer: string
          signal_type: string
          signal_data: any
          created_at?: string
        }
      }
    }
  }
}
