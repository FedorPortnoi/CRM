export const DEFAULT_CURRENCY = 'RUB';

export const DEFAULT_PIPELINE_NAME = 'Воронка продаж';
export const DEFAULT_PIPELINE_STAGE_NAMES = [
  'Новый лид',
  'Квалификация',
  'Предложение',
  'Сделка выиграна',
] as const;

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}
