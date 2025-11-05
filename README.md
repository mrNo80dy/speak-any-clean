# Real-Time Video Translation App

A peer-to-peer video chat application with real-time speech translation, similar to EZDubs.

## Features

- 🎥 WebRTC peer-to-peer video/audio
- 🗣️ Real-time speech recognition
- 🌍 Multi-language translation
- 🔊 Text-to-speech output
- 💬 Live captions with translations

## Setup Instructions

### 1. Database Setup (Supabase)

1. Create a Supabase project at https://supabase.com
2. Run the SQL script in `scripts/01-create-tables.sql` in the Supabase SQL Editor
3. Add your Supabase credentials to environment variables:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`

### 2. Translation Edge Function

1. Install Supabase CLI: `npm install -g supabase`
2. Deploy the edge function:
   \`\`\`bash
   supabase functions deploy translate-text
   \`\`\`
3. Set the OpenAI API key as a secret:
   \`\`\`bash
   supabase secrets set OPENAI_API_KEY=your_openai_key
   \`\`\`

### 3. Development

The app works in "mock mode" without Supabase for UI development. To enable full functionality, add the environment variables above.

## Architecture

- **Frontend**: Next.js 16 with React 19
- **Database**: Supabase (PostgreSQL)
- **Translation**: Supabase Edge Function + OpenAI
- **WebRTC**: Simple-peer for P2P connections
- **Speech**: Web Speech API (recognition + synthesis)

## How It Works

1. Users create or join a room
2. WebRTC establishes peer-to-peer video/audio connections
3. Speech recognition transcribes audio in real-time
4. Transcriptions are translated via Edge Function
5. Translations are displayed as captions and optionally spoken via TTS
