/** Number, date and money formatting for the App Home, in the visitor's language. */
import { getLocale } from '#lib/paraglide/runtime.js';

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'medium', timeStyle: 'short' }).format(
    date,
  );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(getLocale()).format(value);
}

/** A share between 0 and 1 as a whole-number percentage. */
export function formatPercent(share: number): string {
  return new Intl.NumberFormat(getLocale(), { style: 'percent', maximumFractionDigits: 0 }).format(
    share,
  );
}

/** Micro-dollars (the budget ledger's unit) as US dollars. */
export function formatUsd(microUsd: number): string {
  return new Intl.NumberFormat(getLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: microUsd % 1_000_000 === 0 ? 0 : 2,
  }).format(microUsd / 1_000_000);
}
