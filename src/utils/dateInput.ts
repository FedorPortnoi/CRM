// Typed date fields show and accept ДД.ММ.ГГГГ — the way dates are written in Russia —
// while everything behind them (state, API) keeps ISO YYYY-MM-DD. The fields had asked
// people to type the date "backwards" (ГГГГ-ММ-ДД), which nobody here does.

/**
 * As-you-type mask: keeps the digits and puts the dots in, so «28092026» becomes
 * «28.09.2026». Typing a dot yourself works too — non-digits are dropped and re-added.
 */
export function maskDateInput(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}.${d.slice(2)}`;
  return `${d.slice(0, 2)}.${d.slice(2, 4)}.${d.slice(4)}`;
}

/** «28.09.2026» → «2026-09-28»; null unless it is a complete, real calendar date. */
export function displayDateToIso(value: string): string | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);
  const probe = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31.02, 00.10, 15.13 — Date would silently roll them over.
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return null;
  }
  return `${yyyy}-${mm}-${dd}`;
}

/** «2026-09-28» (or a full ISO timestamp's date part) → «28.09.2026»; '' for empty/invalid. */
export function isoToDisplayDate(iso: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}
