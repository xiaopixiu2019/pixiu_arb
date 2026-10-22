import type { Language } from './i18n.js';

/** Formats execution records with a date while preserving the tables' second-level precision. */
export function formatExecutionDateTime(value: string, language: Language): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}
