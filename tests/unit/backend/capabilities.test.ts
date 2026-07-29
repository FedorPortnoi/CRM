import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  assignableRoles,
  can,
  hasAnyWriteCapability,
  isRole,
  type Capability,
  type Role,
} from '../../../backend/services/capabilities';

const ALL_ROLES = Object.keys(ROLE_CAPABILITIES) as Role[];

describe('capabilities — the write gate', () => {
  /**
   * This is the test that justifies the whole module. The old gate asked
   * "is this role viewer?" so any role added later defaulted to WRITABLE.
   * Assert the property directly: a role with no write capability cannot write,
   * whatever it is called.
   */
  it('denies writes to every role that holds no write capability', () => {
    for (const role of ALL_ROLES) {
      const writes = hasAnyWriteCapability(role);
      const holdsAWrite = ROLE_CAPABILITIES[role].some((c) =>
        ['contacts.write', 'deals.write', 'tasks.write', 'activities.write',
         'team.manage', 'org.manage', 'sequences.manage', 'integrations.manage',
         'contacts.bulk', 'team.manage_admins'].includes(c),
      );
      expect(writes, `${role} write-gate disagrees with its capability set`).toBe(holdsAWrite);
    }
  });

  it('keeps viewer and accountant strictly read-only', () => {
    expect(hasAnyWriteCapability('viewer')).toBe(false);
    expect(hasAnyWriteCapability('accountant')).toBe(false);
  });

  it('treats an unknown or missing role as powerless, never as permitted', () => {
    for (const cap of CAPABILITIES) {
      expect(can('rop', cap)).toBe(false);          // plausible but not a real role
      expect(can(undefined, cap)).toBe(false);
      expect(can(null, cap)).toBe(false);
      expect(can('', cap)).toBe(false);
    }
    expect(hasAnyWriteCapability('rop')).toBe(false);
    expect(isRole('rop')).toBe(false);
  });
});

describe('capabilities — role boundaries', () => {
  it('gives owner everything and admin everything but minting admins', () => {
    for (const cap of CAPABILITIES) expect(can('owner', cap)).toBe(true);
    expect(can('admin', 'team.manage_admins')).toBe(false);
    expect(can('admin', 'team.manage')).toBe(true);
    expect(can('admin', 'org.manage')).toBe(true);
  });

  it('does not regress what member could already do', () => {
    // Before capabilities, any non-viewer could write freely inside their cone.
    for (const cap of ['contacts.write', 'deals.write', 'tasks.write', 'activities.write'] as Capability[]) {
      expect(can('member', cap), `member lost ${cap}`).toBe(true);
    }
    // …and could not reach the owner/admin-only surfaces.
    for (const cap of ['org.manage', 'team.manage', 'audit.read', 'data.export',
                       'sequences.manage', 'integrations.manage', 'contacts.bulk',
                       'visibility.all'] as Capability[]) {
      expect(can('member', cap), `member wrongly gained ${cap}`).toBe(false);
    }
  });

  it('makes head identical to member — its reach comes from the hierarchy', () => {
    expect([...ROLE_CAPABILITIES.head].sort()).toEqual([...ROLE_CAPABILITIES.member].sort());
    // If head ever needs org-wide sight it must come from manager_id, not this flag.
    expect(can('head', 'visibility.all')).toBe(false);
  });

  it('lets the accountant see all the money and export it, but change nothing', () => {
    expect(can('accountant', 'revenue.view')).toBe(true);
    expect(can('accountant', 'visibility.all')).toBe(true);
    expect(can('accountant', 'data.export')).toBe(true);
    expect(can('accountant', 'contacts.write')).toBe(false);
    expect(can('accountant', 'deals.write')).toBe(false);
    expect(can('accountant', 'team.manage')).toBe(false);
  });

  it('lets the marketer run campaigns org-wide without touching the pipeline', () => {
    expect(can('marketer', 'sequences.manage')).toBe(true);
    expect(can('marketer', 'visibility.all')).toBe(true);
    expect(can('marketer', 'contacts.read')).toBe(true);
    expect(can('marketer', 'deals.write')).toBe(false);
    expect(can('marketer', 'team.manage')).toBe(false);
  });

  it('confines support to the contact record', () => {
    expect(can('support', 'contacts.write')).toBe(true);
    expect(can('support', 'activities.write')).toBe(true);
    expect(can('support', 'deals.read')).toBe(false);
    expect(can('support', 'deals.write')).toBe(false);
    expect(can('support', 'revenue.view')).toBe(false);
    expect(can('support', 'visibility.all')).toBe(false);
  });

  it('reserves the manager cone bypass to roles that are org-wide by nature', () => {
    const orgWide = ALL_ROLES.filter((r) => can(r, 'visibility.all')).sort();
    expect(orgWide).toEqual(['accountant', 'admin', 'marketer', 'owner']);
  });
});

describe('capabilities — role assignment', () => {
  it('only lets an owner hand out admin, and nobody hand out owner', () => {
    expect(assignableRoles('owner')).toContain('admin');
    expect(assignableRoles('admin')).not.toContain('admin');
    for (const caller of ALL_ROLES) {
      expect(assignableRoles(caller) as string[]).not.toContain('owner');
    }
  });

  it('offers every non-privileged role to an admin', () => {
    expect(assignableRoles('admin').sort()).toEqual(
      ['accountant', 'head', 'marketer', 'member', 'support', 'viewer'],
    );
  });

  it('every assignable role is a real role', () => {
    for (const r of assignableRoles('owner')) expect(isRole(r)).toBe(true);
  });
});
