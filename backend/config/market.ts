export const DEFAULT_CURRENCY = 'RUB';

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}
