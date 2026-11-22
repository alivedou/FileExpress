import { useCallback } from "react";
import en from "../i18n/en.json";
import zh from "../i18n/zh.json";

export type Locale = "zh" | "en";
export type TranslationKey = keyof typeof zh;
const messages: Record<Locale, Record<TranslationKey, string>> = { zh, en };
export function translate(locale: Locale, key: TranslationKey): string { return messages[locale][key] ?? key; }
export function useTranslation(locale: Locale): { t: (key: TranslationKey) => string; locale: Locale } {
  return { t: useCallback((key: TranslationKey) => translate(locale, key), [locale]), locale };
}
