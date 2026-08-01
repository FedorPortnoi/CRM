/**
 * amoCRM REST API v4 wire types.
 *
 * Everything here describes what amoCRM SENDS US. It is deliberately permissive:
 * optional where the docs do not promise a field, `unknown` where the shape is
 * account-dependent (custom fields), and never `any`. A response type that
 * over-promises turns a missing field into a runtime crash three layers away in
 * the import.
 *
 * Anything the published documentation did not confirm is marked `// VERIFY:`.
 * Do not remove those markers by guessing — remove them by checking against a
 * live sandbox account.
 */

// ─── OAuth ────────────────────────────────────────────────────────────────────

/**
 * The token endpoint's success body, for BOTH grant types.
 *
 * `refresh_token` is NOT optional in practice and must not be treated as such:
 * amoCRM rotates it on every refresh, so a response without one means the old
 * one is already dead and we have nothing to store. The code treats a missing
 * refresh_token as a hard error rather than silently keeping the consumed one.
 */
export interface AmoTokenResponse {
  token_type: string;
  /** Seconds. amoCRM issues 86400 (24 h) for the access token. */
  expires_in: number;
  access_token: string;
  refresh_token: string;
}

/**
 * The token endpoint's failure body.
 *
 * amoCRM answers OAuth failures with an RFC 7807-ish envelope rather than the
 * bare RFC 6749 `{"error": "invalid_grant"}`. Both shapes are modelled because
 * the platform has used both over time and a proxy may normalise one to the
 * other — `isInvalidGrant()` in auth.ts reads every one of these fields.
 */
export interface AmoOAuthErrorResponse {
  /** RFC 6749 form, e.g. 'invalid_grant' | 'invalid_client' | 'invalid_request'. */
  error?: string;
  error_description?: string;
  /** amoCRM's envelope. */
  hint?: string;
  title?: string;
  detail?: string;
  message?: string;
  status?: number;
  type?: string;
  code?: number | string;
  /** Present on validation failures. */
  'validation-errors'?: unknown;
}

/** What the OAuth callback carries back on the redirect. */
export interface AmoOAuthCallbackQuery {
  code?: string;
  state?: string;
  /**
   * The account's own domain, e.g. 'example.amocrm.ru'. amoCRM sends this so an
   * integration serving many accounts knows WHICH account just authorised — the
   * token endpoint lives on the account's own host, so without it there is no
   * URL to POST to.
   */
  referer?: string;
  client_id?: string;
  /** '1' when the flow started from a widget rather than the consent page. */
  from_widget?: string;
  /** Present when the user declined or the platform rejected the request. */
  error?: string;
  error_description?: string;
}

// ─── Envelope ─────────────────────────────────────────────────────────────────

/** amoCRM's HAL-ish link object. */
export interface AmoLink {
  href: string;
}

export interface AmoLinks {
  self?: AmoLink;
  next?: AmoLink;
  first?: AmoLink;
  prev?: AmoLink;
}

/**
 * A list response. `_embedded` is keyed by the plural entity name — `leads`,
 * `contacts`, `companies`, `pipelines`, `custom_fields`, … — which is why
 * paginate() has to be told (or infer) which key to read.
 *
 * When a filtered list matches nothing, amoCRM answers **204 No Content with an
 * empty body**, not 200 with an empty array. `amoRequest` maps that to `null`;
 * `paginate` treats it as "no more pages".
 */
export interface AmoCollection<T> {
  _page?: number;
  _links?: AmoLinks;
  _embedded?: Record<string, T[] | undefined>;
  _total_items?: number;
  _page_count?: number;
}

/** The error body of a non-OAuth API failure. */
export interface AmoApiErrorResponse {
  title?: string;
  type?: string;
  status?: number;
  detail?: string;
  hint?: string;
  'validation-errors'?: Array<{
    request_id?: string;
    errors?: Array<{ code?: string; path?: string; detail?: string }>;
  }>;
}

// ─── Custom fields ────────────────────────────────────────────────────────────

/**
 * One custom-field value as it appears ON an entity.
 *
 * `value` is genuinely polymorphic: string for text, number for numeric, boolean
 * for checkbox, and an object for the composite types (address, legal entity).
 * It is left `unknown` on purpose — the mapping layer must narrow it explicitly
 * rather than inherit a lie from this file.
 */
export interface AmoFieldValue {
  value: unknown;
  /** Set for enum-backed fields (phone/email types, select options). */
  enum_id?: number | null;
  enum_code?: string | null;
}

export interface AmoCustomFieldValue {
  field_id: number;
  field_name?: string;
  field_code?: string | null;
  field_type?: string;
  values: AmoFieldValue[];
}

/** A custom-field definition from GET /api/v4/{entity}/custom_fields. */
export interface AmoCustomFieldDefinition {
  id: number;
  name: string;
  code?: string | null;
  /** 'text' | 'numeric' | 'checkbox' | 'select' | 'multiselect' | 'date' | 'url' | 'textarea' | 'radiobutton' | 'streetaddress' | 'smart_address' | 'birthday' | 'legal_entity' | 'date_time' | 'price' | 'category' | 'items' | 'tracking_data' | 'linked_entity' | 'chained_list' | 'monetary' | 'file' | 'payer' | 'supplier' | 'multitext' … */
  type: string;
  sort?: number;
  is_api_only?: boolean;
  enums?: Array<{ id: number; value: string; sort?: number; code?: string | null }> | null;
  entity_type?: string;
}

// ─── Entities ─────────────────────────────────────────────────────────────────

/** Fields every amoCRM entity carries. Timestamps are UNIX seconds, not ms. */
interface AmoEntityBase {
  id: number;
  responsible_user_id?: number;
  group_id?: number;
  created_by?: number;
  updated_by?: number;
  /** UNIX seconds. */
  created_at?: number;
  /** UNIX seconds. */
  updated_at?: number;
  account_id?: number;
  custom_fields_values?: AmoCustomFieldValue[] | null;
  _links?: AmoLinks;
  _embedded?: Record<string, unknown>;
}

export interface AmoContact extends AmoEntityBase {
  name?: string;
  first_name?: string;
  last_name?: string;
  is_deleted?: boolean;
  closest_task_at?: number | null;
}

export interface AmoCompany extends AmoEntityBase {
  name?: string;
  is_deleted?: boolean;
  closest_task_at?: number | null;
}

export interface AmoLead extends AmoEntityBase {
  name?: string;
  price?: number;
  status_id?: number;
  pipeline_id?: number;
  loss_reason_id?: number | null;
  /** UNIX seconds; set when the lead reached a won/lost status. */
  closed_at?: number | null;
  closest_task_at?: number | null;
  is_deleted?: boolean;
  score?: number | null;
  /** Present only when requested with `with=` — see AMO_LEAD_WITH. */
  is_price_modified_by_robot?: boolean;
}

export interface AmoPipelineStatus {
  id: number;
  name: string;
  sort?: number;
  is_editable?: boolean;
  pipeline_id?: number;
  color?: string;
  /** 0 = normal, 1 = unsorted/incoming leads. */
  type?: number;
  account_id?: number;
}

export interface AmoPipeline {
  id: number;
  name: string;
  sort?: number;
  is_main?: boolean;
  is_unsorted_on?: boolean;
  is_archive?: boolean;
  account_id?: number;
  _embedded?: { statuses?: AmoPipelineStatus[] };
}

export interface AmoUser {
  id: number;
  name?: string;
  email?: string;
  lang?: string;
  rights?: Record<string, unknown>;
}

export interface AmoTask extends Omit<AmoEntityBase, 'custom_fields_values'> {
  /** 'leads' | 'contacts' | 'companies' | 'customers' */
  entity_type?: string | null;
  entity_id?: number | null;
  duration?: number;
  is_completed?: boolean;
  task_type_id?: number;
  text?: string;
  result?: { text?: string } | null;
  /** UNIX seconds. */
  complete_till?: number;
}

export interface AmoNote extends Omit<AmoEntityBase, 'custom_fields_values'> {
  entity_id?: number;
  note_type?: string;
  params?: Record<string, unknown>;
}

/** GET /api/v4/account. Cheap enough to serve as a token-validity probe. */
export interface AmoAccount {
  id: number;
  name?: string;
  subdomain?: string;
  created_at?: number;
  created_by?: number;
  updated_at?: number;
  updated_by?: number;
  /** IANA zone, e.g. 'Europe/Moscow'. */
  currency?: string;
  timezone?: string;
  timezone_offset?: string;
  language?: string;
  /** Present only with `?with=amojo_id` etc. */
  amojo_id?: string;
  version?: number;
  _embedded?: Record<string, unknown>;
}

// ─── Webhooks ─────────────────────────────────────────────────────────────────

/**
 * One webhook subscription as GET/POST /api/v4/webhooks returns it.
 *
 * NOTE the id type. amoCRM has returned webhook ids as an integer in some
 * responses and as a string in others; `webhook_ids` on AmoIntegration is
 * `String[]`, so everything is normalised to string on the way in.
 */
export interface AmoWebhook {
  id?: number | string;
  destination: string;
  created_at?: number;
  updated_at?: number;
  /** e.g. ['add_lead', 'update_lead', 'add_contact', 'delete_contact'] */
  settings: string[];
  sort?: number;
  disabled?: boolean;
  _links?: AmoLinks;
}

// ─── Shared constants ─────────────────────────────────────────────────────────

/**
 * amoCRM caps a page at 250 and rejects more. Batch create/update caps at 500
 * entities but 250 is the documented recommendation, so both the reader and the
 * writer use the same number and there is one page size to reason about.
 */
export const AMO_PAGE_LIMIT = 250;

/** Hard ceiling on a batch write. Never send more than this in one request. */
export const AMO_MAX_BATCH = 500;

/** What we actually send in a batch — amoCRM's own recommendation. */
export const AMO_RECOMMENDED_BATCH = 250;

/** amoCRM's per-integration rate ceiling. The bucket runs below this. */
export const AMO_RATE_LIMIT_PER_SECOND = 7;

/**
 * The plural collection name inside `_embedded` for each entity path. Used by
 * paginate() to find the array without the caller having to spell it out for the
 * common cases.
 */
export const AMO_EMBEDDED_KEYS: Record<string, string> = {
  leads: 'leads',
  contacts: 'contacts',
  companies: 'companies',
  customers: 'customers',
  tasks: 'tasks',
  notes: 'notes',
  events: 'events',
  users: 'users',
  pipelines: 'pipelines',
  statuses: 'statuses',
  custom_fields: 'custom_fields',
  webhooks: 'webhooks',
  tags: 'tags',
  catalogs: 'catalogs',
  segments: 'segments',
  calls: 'calls',
};

/** A UNIX-seconds timestamp from amoCRM as a JS Date, or null. */
export function amoTimestampToDate(seconds: number | null | undefined): Date | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return new Date(seconds * 1000);
}

/** A JS Date as the UNIX-seconds integer amoCRM expects on write. */
export function dateToAmoTimestamp(date: Date | null | undefined): number | null {
  if (!date || Number.isNaN(date.getTime())) return null;
  return Math.floor(date.getTime() / 1000);
}
