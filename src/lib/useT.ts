import { translations, type TranslationDict } from './translations';

let currentLang: 'en' | 'zh' = 'zh';

export function setLang(lang: 'en' | 'zh') {
  currentLang = lang;
}

export function useT(): TranslationDict {
  return translations[currentLang];
}

export function t(key: string): string {
  const dict = translations[currentLang];
  return dict[key] || key;
}
