import { describe, expect, it } from 'vitest';
import {
  mergeAmoImportResults,
  roleCanImportAmo,
  roleCanManageAmo,
  type AmoImportResult,
} from '../../../src/hooks/amocrmTypes';

function result(overrides: Partial<AmoImportResult> = {}): AmoImportResult {
  return {
    contacts_imported: 0,
    contacts_failed: 0,
    deals_imported: 0,
    deals_failed: 0,
    total_contacts: 0,
    companies_seen: 0,
    companies_failed: 0,
    pipelines_created: 0,
    pipelines_updated: 0,
    stages_created: 0,
    stages_updated: 0,
    warnings: [],
    partial: false,
    ...overrides,
  };
}

describe('amoCRM UI capability mirror', () => {
  it.each(['owner', 'admin'])('allows %s to manage and import', (role) => {
    expect(roleCanManageAmo(role)).toBe(true);
    expect(roleCanImportAmo(role)).toBe(true);
  });

  it.each(['head', 'member', 'accountant', 'marketer', 'support', 'viewer', null, undefined])(
    'does not expose integration actions to %s',
    (role) => {
      expect(roleCanManageAmo(role)).toBe(false);
      expect(roleCanImportAmo(role)).toBe(false);
    },
  );
});

describe('cursor import result accumulation', () => {
  it('adds counters, keeps the latest cursor and deduplicates warnings', () => {
    const warning = {
      code: 'EMPTY_PIPELINE' as const,
      amo_pipeline_id: 4,
      amo_status_id: null,
      stage_name: null,
      flag: null,
      message: 'empty',
    };
    const first = result({
      contacts_imported: 10,
      deals_imported: 4,
      pipelines_created: 1,
      warnings: [warning],
      partial: true,
      cursor: { phase: 'contacts', page: 2 },
    });
    const second = result({
      contacts_imported: 7,
      contacts_failed: 1,
      deals_imported: 3,
      warnings: [warning],
      partial: true,
      cursor: { phase: 'leads', page: 3 },
    });

    expect(mergeAmoImportResults(first, second)).toMatchObject({
      contacts_imported: 17,
      contacts_failed: 1,
      deals_imported: 7,
      pipelines_created: 1,
      partial: true,
      cursor: { phase: 'leads', page: 3 },
      warnings: [warning],
    });
  });

  it('uses a first result unchanged', () => {
    const first = result({ contacts_imported: 2 });
    expect(mergeAmoImportResults(null, first)).toBe(first);
  });
});
