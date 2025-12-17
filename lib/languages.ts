// lib/languages.ts

export type LanguageConfig = {
  code: string;   // BCP-47 code (what SpeechRecognition / SpeechSynthesis expect)
  label: string;  // UI label
};

export const LANGUAGES: LanguageConfig[] = [
  { code: "en-US", label: "English (US)" },
  { code: "es-ES", label: "Español (España)" },
  { code: "es-MX", label: "Español (México)" },
  { code: "pt-BR", label: "Português (Brasil)" },
  { code: "fr-FR", label: "Français (France)" },
  { code: "de-DE", label: "Deutsch (Deutschland)" },
  { code: "it-IT", label: "Italiano (Italia)" },
  { code: "ru-RU", label: "Русский (Россия)" },
  { code: "ar-SA", label: "العربية (السعودية)" },
  { code: "hi-IN", label: "हिन्दी (India)" },
  { code: "bn-BD", label: "বাংলা (Bangladesh)" },
  { code: "ur-PK", label: "اردو (Pakistan)" },
  { code: "id-ID", label: "Bahasa Indonesia" },
  { code: "tr-TR", label: "Türkçe (Türkiye)" },
  { code: "vi-VN", label: "Tiếng Việt (Vietnam)" },
  { code: "th-TH", label: "ไทย (Thailand)" },
  { code: "ja-JP", label: "日本語 (Japan)" },
  { code: "ko-KR", label: "한국어 (Korea)" },
  { code: "zh-CN", label: "中文 (简体, China)" },
  { code: "zh-TW", label: "中文 (繁體, Taiwan)" },
];
