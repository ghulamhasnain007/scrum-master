import 'dotenv/config';

export const config = {
  port: parseInt(process.env.PORT ?? '3001', 10),
  host: process.env.HOST ?? '0.0.0.0',
  geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  // gemini-2.5-flash-native-audio-preview-12-2025 gives the best voice quality;
  // falls back to gemini-2.0-flash-live-001 which is GA and free-tier friendly.
  geminiModel: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash-native-audio-preview-12-2025',
  defaultMeetingDurationMs: 5 * 60 * 1000,
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
} as const;

if (!config.geminiApiKey) {
  throw new Error('GEMINI_API_KEY environment variable is required. Get one free at https://aistudio.google.com/apikey');
}
