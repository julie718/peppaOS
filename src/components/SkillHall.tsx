import React from 'react';
import { SkillCenter } from './SkillCenter';

/** Thin wrapper — delegates to SkillCenter, the canonical skill hall component. */
export function SkillHall({ t, lang }: { t: any; lang: 'en' | 'zh' }) {
  return <SkillCenter t={t} lang={lang} />;
}
