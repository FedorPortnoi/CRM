export const DEFAULT_CURRENCY = 'RUB';

/**
 * The zone a user is assumed to be in until they say otherwise.
 *
 * Moved here from notificationEngine's DISPLAY_TIME_ZONE, which asked in a comment to be
 * relocated "if a second place ever needs to render a date for a user". Reminders are that
 * second place, and they need it for more than rendering: a reminder set for 09:00 is
 * scheduled in the recipient's zone, so the default is now load-bearing rather than cosmetic.
 */
export const DEFAULT_TIME_ZONE = 'Europe/Moscow';

export const DEFAULT_PIPELINE_NAME = 'Воронка продаж';
export const DEFAULT_PIPELINE_STAGE_NAMES = [
  'Новый лид',
  'Квалификация',
  'Предложение',
  'Сделка выиграна',
] as const;

export interface StageTemplate {
  /** Stable key, so the client can mark an already-added template without matching on name. */
  key: string;
  name: string;
  /** Where this normally sits relative to the four defaults; the client orders the picker by it. */
  suggested_position: number;
  color: string;
  probability?: number;
  is_won_stage?: boolean;
  is_lost_stage?: boolean;
  /** Shown under the name in the picker — why an org would want this stage. */
  rationale: string;
  /** The three offered up front; the rest sit behind "показать все". */
  recommended: boolean;
}

/**
 * Stages an organization can add to the four it starts with.
 *
 * This is a menu, not a schema: PipelineStage has always been free-form, and nothing here is
 * privileged over a name somebody types themselves. It exists because "add a stage" with an
 * empty text box gets a worse funnel than one that suggests what the market actually uses —
 * and because these names line up with amoCRM's standard statuses, which is what makes the
 * import mapping in the amoCRM integration mostly automatic.
 *
 * `recommended` marks the three that earn their place in almost every Russian B2B funnel.
 */
export const OPTIONAL_STAGE_LIBRARY: readonly StageTemplate[] = [
  {
    key: 'first_contact',
    name: 'Первичный контакт',
    suggested_position: 0,
    color: '#94A3B8',
    probability: 5,
    rationale: 'Отдельный шаг до квалификации, если лиды приходят сырыми.',
    recommended: false,
  },
  {
    key: 'negotiation',
    name: 'Переговоры',
    suggested_position: 2,
    color: '#38BDF8',
    probability: 30,
    rationale: 'Стандартный этап amoCRM. Есть почти в каждой российской воронке.',
    recommended: true,
  },
  {
    key: 'contract_approval',
    name: 'Согласование договора',
    suggested_position: 4,
    color: '#A78BFA',
    probability: 75,
    rationale: 'Юридическая правка — где B2B-сделки стоят дольше всего.',
    recommended: false,
  },
  {
    key: 'invoice_issued',
    name: 'Выставлен счёт',
    suggested_position: 5,
    color: '#FBBF24',
    probability: 85,
    rationale: 'Разрыв между «договорились» и «оплатили» — где реально теряются деньги.',
    recommended: true,
  },
  {
    key: 'paid',
    name: 'Оплачено',
    suggested_position: 6,
    color: '#34D399',
    probability: 95,
    rationale: 'Отделяет поступление денег от закрытия сделки.',
    recommended: false,
  },
  {
    key: 'shipment',
    name: 'Отгрузка',
    suggested_position: 7,
    color: '#22D3EE',
    probability: 95,
    rationale: 'Для торговли и логистики: обязательства после оплаты.',
    recommended: false,
  },
  {
    key: 'deferred',
    name: 'Отложено',
    suggested_position: 8,
    color: '#CBD5E1',
    probability: 10,
    rationale: 'Парковка. Без неё зависшие сделки портят конверсию активных этапов.',
    recommended: false,
  },
  {
    key: 'lost',
    name: 'Сделка провалена',
    suggested_position: 98,
    color: '#F87171',
    probability: 0,
    is_lost_stage: true,
    rationale:
      'Сейчас проигранная сделка остаётся на своём этапе со status=lost, из-за чего отток по этапам неоднозначен.',
    recommended: true,
  },
  {
    key: 'repeat_sale',
    name: 'Повторная продажа',
    suggested_position: 99,
    color: '#F472B6',
    probability: 40,
    rationale: 'Удержание: возврат клиента в воронку после успешной сделки.',
    recommended: false,
  },
] as const;

export function findStageTemplate(key: string): StageTemplate | undefined {
  return OPTIONAL_STAGE_LIBRARY.find((s) => s.key === key);
}

export function normalizeCurrencyCode(value: string): string {
  return value.trim().toUpperCase();
}
