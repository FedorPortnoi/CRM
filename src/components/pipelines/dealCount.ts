// Shared by the stage row's count chip and the move-deals picker, so «2 сделки» is worded
// the same in the list and in the question about that same list.
//
// Not i18next pluralisation: this project runs compatibilityJSON 'v4' but has no v4 plural
// keys anywhere (the one existing plural, workflows.actions_plural, is v3-style and does not
// resolve), so the rule lives here instead — the same shape as the plural() helper in
// src/app/settings/team.tsx.

/**
 * Russian needs three forms and a funnel stage genuinely holds 1, 3 and 17 deals, so
 * «1 сделка» / «3 сделки» / «17 сделок» all occur on one screen. Other locales fall back to
 * the two-form rule rather than inheriting Russian's, which would print "21 deal".
 */
export function formatDealCount(
  n: number,
  language: string,
  t: (key: string) => string,
): string {
  if (!language.startsWith('ru')) {
    return `${n} ${t(n === 1 ? 'pipelines.dealsOne' : 'pipelines.dealsMany')}`;
  }

  const mod10 = n % 10;
  const mod100 = n % 100;

  let key: string;
  if (mod10 === 1 && mod100 !== 11) key = 'pipelines.dealsOne';
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) key = 'pipelines.dealsFew';
  else key = 'pipelines.dealsMany';

  return `${n} ${t(key)}`;
}
