/**
 * Role capabilities — the single source of truth for "what may this role do".
 *
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * Authorization used to be 18 string comparisons (`role === 'admin'`,
 * `role !== 'owner'`) spread over 11 files. That works for a closed set of four
 * roles and fails badly the moment a fifth appears: a new role lands in whichever
 * branch happens to be the `else`. Concretely, before this module existed, adding
 * `accountant` would have sailed past the viewer write-gate with FULL WRITE
 * ACCESS, because that gate asked "is this role viewer?" rather than "may this
 * role write?".
 *
 * Capabilities invert the question. Every gate asks what is permitted, never who
 * is asking, so a new role is a row in ROLE_CAPABILITIES rather than an audit of
 * every controller.
 *
 * -----------------------------------------------------------------------------
 * THE TWO AXES — do not conflate them
 * -----------------------------------------------------------------------------
 * ROLE answers "what may you do" (this file).
 * HIERARCHY (`User.manager_id` + the recursive CTE in visibility.ts) answers
 * "whose records may you see".
 *
 * They are deliberately independent. A РОП who sees their team's deals is a
 * `head` who has people reporting to them — not a role with special powers. Do
 * not add a capability that re-implements the org chart; it will drift from the
 * hierarchy and the two will disagree.
 *
 * `visibility.all` is the ONE bridge between the axes: it means "ignore the cone,
 * this role is org-wide by nature" (an accountant closing the books needs every
 * deal, not just their branch).
 */

export const CAPABILITIES = [
  'org.manage',           // organisation settings, join code, plan
  'team.read',            // see the member list
  'team.manage',          // add, deactivate, re-role members
  'team.manage_admins',   // create or modify admin-level members (owner only)
  'audit.read',           // the audit log
  'data.export',          // CSV/PDF export of org data
  'visibility.all',       // bypass the manager cone; see the whole org
  'contacts.read',
  'contacts.write',
  'contacts.bulk',        // import, bulk assign/archive, merge
  'deals.read',
  'deals.write',
  'tasks.read',
  'tasks.write',
  'activities.write',     // notes, logged calls, captures
  'revenue.view',         // monetary figures and revenue analytics
  'sequences.manage',     // email sequences and templates
  'integrations.manage',  // webhooks and API keys
] as const;

export type Capability = (typeof CAPABILITIES)[number];

export type Role =
  | 'owner'
  | 'admin'
  | 'head'        // РОП / руководитель отдела
  | 'member'      // менеджер по продажам
  | 'accountant'  // бухгалтер / финансы
  | 'marketer'    // маркетолог
  | 'support'     // поддержка / оператор
  | 'viewer';

const READ_ONLY: Capability[] = ['team.read', 'contacts.read', 'deals.read', 'tasks.read'];

/**
 * Sales-facing write set shared by member and head. Kept as a constant so the
 * two cannot drift apart silently — head is deliberately "member plus reach",
 * and its extra reach comes from the hierarchy, not from extra capabilities.
 */
const SALES: Capability[] = [
  ...READ_ONLY,
  'contacts.write',
  'deals.write',
  'tasks.write',
  'activities.write',
  'revenue.view',
];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = {
  // Everything, including the owner-only power to mint other admins.
  owner: CAPABILITIES,

  // An admin runs the org day to day but cannot create or demote admins; that
  // asymmetry already existed (auth.ts refused `admin` creating `admin`) and is
  // preserved here rather than quietly widened.
  admin: CAPABILITIES.filter((c) => c !== 'team.manage_admins'),

  // РОП. Same powers as a sales manager; the breadth of what they SEE comes from
  // having reports under them in the org chart, which is why there is no
  // 'visibility.all' here.
  head: SALES,

  // Sales manager — the default for a new employee.
  member: SALES,

  // Reads the whole org's money and can export it. Deliberately no writes at
  // all: a bookkeeper who can edit a client record is an audit problem.
  accountant: [...READ_ONLY, 'revenue.view', 'visibility.all', 'data.export'],

  // Campaigns reach the whole contact base, so org-wide read is inherent to the
  // job. No deals.write — a marketer should not be moving someone's deal.
  marketer: [
    'team.read',
    'contacts.read',
    'contacts.write',
    'deals.read',
    'tasks.read',
    'tasks.write',
    'activities.write',
    'revenue.view',
    'visibility.all',
    'sequences.manage',
  ],

  // Front line: works the contact record and logs what happened. No pipeline,
  // no money.
  support: ['team.read', 'contacts.read', 'contacts.write', 'tasks.read', 'tasks.write', 'activities.write'],

  // Strictly read-only. hasAnyWriteCapability() below is what actually enforces
  // this at the request gate.
  viewer: READ_ONLY,
};

const WRITE_CAPABILITIES: readonly Capability[] = [
  'org.manage',
  'team.manage',
  'team.manage_admins',
  'contacts.write',
  'contacts.bulk',
  'deals.write',
  'tasks.write',
  'activities.write',
  'sequences.manage',
  'integrations.manage',
];

export function isRole(value: string): value is Role {
  return Object.prototype.hasOwnProperty.call(ROLE_CAPABILITIES, value);
}

/**
 * The only authorization question the rest of the backend should ask.
 *
 * An unknown role string resolves to NO capabilities rather than throwing. A row
 * whose role we cannot interpret is denied everything — the safe direction. It
 * can happen legitimately during a rollout where the database has an enum value
 * this build predates.
 */
export function can(role: string | null | undefined, capability: Capability): boolean {
  if (!role || !isRole(role)) return false;
  return ROLE_CAPABILITIES[role].includes(capability);
}

/**
 * Every role that holds a capability. The map read backwards.
 *
 * Exists because some gates are not "may the CALLER do X" but "is the TARGET
 * one of the protected ones" — and those were written as role-name comparisons
 * (`target.role === 'owner'`), which is the failure mode this whole module was
 * built to end. A deny-list of one string does not notice `admin`, and would not
 * notice a ninth role added next year either.
 */
export function rolesWith(capability: Capability): Role[] {
  return (Object.keys(ROLE_CAPABILITIES) as Role[]).filter((role) => can(role, capability));
}

/**
 * Is this role admin-level — i.e. one of the ones CAPABILITIES reserves to the
 * owner with 'team.manage_admins' ("create or modify admin-level members")?
 *
 * Asked of the map, so a future role granted 'team.manage' is protected the day
 * it is added rather than the day someone remembers to update a string list.
 */
export function isAdminLevelRole(role: string | null | undefined): boolean {
  return can(role, 'team.manage');
}

/** True when the role may perform any mutation at all. Powers the write gate. */
export function hasAnyWriteCapability(role: string | null | undefined): boolean {
  if (!role || !isRole(role)) return false;
  return ROLE_CAPABILITIES[role].some((c) => WRITE_CAPABILITIES.includes(c));
}

/**
 * Every role that may ever be assigned to somebody. `owner` is absent by design
 * — it is established when the organisation is created and transferred, never
 * handed out through the normal role endpoints.
 *
 * Exported as a tuple because zod's `z.enum` requires a non-empty literal tuple;
 * schemas build from this so a new role becomes assignable by editing one list
 * instead of hunting for hardcoded enums in route definitions.
 */
export const ASSIGNABLE_ROLE_VALUES = [
  'admin',
  'head',
  'member',
  'accountant',
  'marketer',
  'support',
  'viewer',
] as const satisfies readonly Role[];

/** Roles a caller may assign. Only an owner can hand out `admin`; nobody assigns `owner`. */
export function assignableRoles(callerRole: string | null | undefined): Role[] {
  return ASSIGNABLE_ROLE_VALUES.filter(
    (r) => r !== 'admin' || can(callerRole, 'team.manage_admins'),
  );
}
