// lib/languages.ts

export type LanguageConfig = {
  code: string;   // BCP-47 code
  label: string;  // UI label
};

export const LANGUAGES: LanguageConfig[] = [
  { code: "en-US", label: "English (US)" },
  { code: "pt-BR", label: "Português (Brasil)" },

  // ready for expansion:
  { code: "es-ES", label: "Español (España)" },
  { code: "es-MX", label: "Español (México)" },
  { code: "fr-FR", label: "Français (France)" },
  { code: "de-DE", label: "Deutsch (Deutschland)" },
  { code: "it-IT", label: "Italiano" },
  // add more as backend support grows
];
