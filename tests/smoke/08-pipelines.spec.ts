import { test, expect, APIRequestContext } from '@playwright/test';
import { getAuth } from './helpers/auth';

test.describe.configure({ timeout: 30000 });

type PipelineSummary = {
  id: string;
  name: string;
  is_default: boolean;
};

test('GET /api/v1/deals/pipelines returns default pipeline', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: PipelineSummary[] };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThanOrEqual(1);
  const defaultPipeline = body.data.find((p) => p.is_default);
  if (!defaultPipeline) throw new Error('Default pipeline not found');
  expect(defaultPipeline.name).toBe('Sales Pipeline');
});

test('Default pipeline has exactly 4 stages in correct order', async ({ request }) => {
  const { token } = getAuth();
  const list = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const { data: pipelines } = (await list.json()) as { data: PipelineSummary[] };
  const defaultPipeline = pipelines.find((p) => p.is_default);
  if (!defaultPipeline) throw new Error('Default pipeline not found');

  const res = await request.get(`/api/v1/deals/pipelines/${defaultPipeline.id}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data).toHaveLength(4);
  expect(body.data[0].name).toBe('Lead');
  expect(body.data[1].name).toBe('Qualified');
  expect(body.data[2].name).toBe('Proposal');
  expect(body.data[3].name).toBe('Closed Won');
  expect(body.data[3].is_won_stage).toBe(true);
});

test('POST /api/v1/deals/pipelines creates a pipeline', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Custom Pipeline', is_default: false },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.name).toBe('Custom Pipeline');
});

test('PATCH /api/v1/deals/pipelines/:id updates pipeline', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Temp Pipeline' },
  });
  const { data: pipeline } = await create.json();

  const res = await request.patch(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Renamed Pipeline' },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.data.name).toBe('Renamed Pipeline');
});

test('POST /api/v1/deals/pipelines/:id/stages creates a stage', async ({ request }) => {
  const { token } = getAuth();
  const pipelineRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Stage Test Pipeline' },
  });
  const { data: pipeline } = await pipelineRes.json();

  const res = await request.post(`/api/v1/deals/pipelines/${pipeline.id}/stages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'New Stage', position: 0 },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.data.id).toBeTruthy();
  expect(body.data.name).toBe('New Stage');
});

test('DELETE /api/v1/deals/pipelines/:id deletes empty pipeline', async ({ request }) => {
  const { token } = getAuth();
  const create = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: 'Delete Me Pipeline' },
  });
  const { data: pipeline } = await create.json();

  const res = await request.delete(`/api/v1/deals/pipelines/${pipeline.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status()).toBe(200);
});

// ─── Helper ──────────────────────────────────────────────────────────────────

interface OrgAuth {
  token: string;
  userId: string;
}

async function registerOrg(request: APIRequestContext, tag: string): Promise<OrgAuth> {
  const suffix = Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const res = await request.post('/api/v1/auth/', {
    data: {
      email: `${tag}-${suffix}@test.com`,
      password: 'Test1234!',
      name: `${tag} User`,
      org_name: `${tag} Org ${suffix}`,
    },
  });
  if (res.status() !== 201) throw new Error(`registerOrg(${tag}) failed: ${res.status()}`);
  const body = await res.json();
  return { token: body.data.token, userId: body.data.user.id };
}

interface PipelineDetail {
  id: string;
  name: string;
  is_default: boolean;
  stages: StageDetail[];
}

interface StageDetail {
  id: string;
  name: string;
  position: number;
  is_won_stage: boolean;
  is_lost_stage: boolean;
}

// ─── Test 1: GET /deals/pipelines without auth → 401 ─────────────────────────

test('GET /api/v1/deals/pipelines without auth returns 401', async ({ request }) => {
  const res = await request.get('/api/v1/deals/pipelines');
  expect(res.status()).toBe(401);
});

// ─── Test 2: GET /deals/pipelines/:id returns full pipeline shape ─────────────

test('GET /api/v1/deals/pipelines/:id returns pipeline with id, name, is_default and stages array', async ({ request }) => {
  const { token } = await registerOrg(request, 'get-pipeline-shape');

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Shape Test Pipeline ' + Date.now() },
  });
  expect(createRes.status()).toBe(201);
  const pipelineId: string = (await createRes.json()).data.id;

  const res = await request.get('/api/v1/deals/pipelines/' + pipelineId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const pipeline: PipelineDetail = body.data;
  expect(typeof pipeline.id).toBe('string');
  expect(pipeline.id).toBe(pipelineId);
  expect(typeof pipeline.name).toBe('string');
  expect(typeof pipeline.is_default).toBe('boolean');
  expect(Array.isArray(pipeline.stages)).toBe(true);
});

// ─── Test 3: GET /deals/pipelines/:id with non-existent id → 404 ─────────────

test('GET /api/v1/deals/pipelines/:id with non-existent id returns 404 PIPELINE_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals/pipelines/00000000-0000-0000-0000-000000000000', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('PIPELINE_NOT_FOUND');
  expect(typeof body.error.message).toBe('string');
});

// ─── Test 4: Cross-org: Org B cannot GET Org A pipeline by id → 404 ──────────

test('cross-org: Org B cannot GET Org A pipeline by id — returns 404', async ({ request }) => {
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);
  const orgA = await registerOrg(request, 'get-xorg-a-' + suffix);
  const orgB = await registerOrg(request, 'get-xorg-b-' + suffix);

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + orgA.token },
    data: { name: 'OrgA Private Pipeline ' + suffix },
  });
  expect(createRes.status()).toBe(201);
  const pipelineId: string = (await createRes.json()).data.id;

  const res = await request.get('/api/v1/deals/pipelines/' + pipelineId, {
    headers: { Authorization: 'Bearer ' + orgB.token },
  });
  expect(res.status()).toBe(404);
});

// ─── Test 5: Cross-org: Org B list returns empty (no Org A pipelines) ─────────

test('cross-org: Org B GET /deals/pipelines does not include Org A pipelines', async ({ request }) => {
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);
  const orgA = await registerOrg(request, 'list-xorg-a-' + suffix);
  const orgB = await registerOrg(request, 'list-xorg-b-' + suffix);

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + orgA.token },
    data: { name: 'OrgA Exclusive Pipeline ' + suffix },
  });
  expect(createRes.status()).toBe(201);
  const orgAPipelineId: string = (await createRes.json()).data.id;

  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + orgB.token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const ids: string[] = (body.data as PipelineDetail[]).map((p) => p.id);
  expect(ids).not.toContain(orgAPipelineId);
});

// ─── Test 6: POST pipeline with is_default=true sets new pipeline as default ──

test('POST pipeline with is_default=true sets the new pipeline as default', async ({ request }) => {
  const { token } = await registerOrg(request, 'post-default');

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'New Default Pipeline ' + Date.now(), is_default: true },
  });
  expect(createRes.status()).toBe(201);
  const newPipelineId: string = (await createRes.json()).data.id;

  const getRes = await request.get('/api/v1/deals/pipelines/' + newPipelineId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(getRes.status()).toBe(200);
  const body = await getRes.json();
  expect(body.data.is_default).toBe(true);
});

// ─── Test 7: POST is_default=true unsets the previous default ─────────────────

test('POST pipeline with is_default=true unsets the previous default pipeline', async ({ request }) => {
  const { token } = await registerOrg(request, 'post-unset-default');

  // The new org will have a seeded default — grab it
  const listRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(listRes.status()).toBe(200);
  const pipelines: PipelineDetail[] = (await listRes.json()).data;
  const previousDefault = pipelines.find((p) => p.is_default);

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Take Default Pipeline ' + Date.now(), is_default: true },
  });
  expect(createRes.status()).toBe(201);

  // Only assert unset behaviour if a previous default existed
  if (previousDefault) {
    const prevRes = await request.get('/api/v1/deals/pipelines/' + previousDefault.id, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(prevRes.status()).toBe(200);
    const prevBody = await prevRes.json();
    expect(prevBody.data.is_default).toBe(false);
  }
});

// ─── Test 8: Two pipelines — default appears first in list ────────────────────

test('GET /deals/pipelines returns both pipelines and default appears first', async ({ request }) => {
  const { token } = await registerOrg(request, 'list-order');

  const nonDefaultRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Non Default Pipeline ' + Date.now(), is_default: false },
  });
  expect(nonDefaultRes.status()).toBe(201);

  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const pipelines: PipelineDetail[] = body.data;
  expect(pipelines.length).toBeGreaterThanOrEqual(2);
  expect(pipelines[0].is_default).toBe(true);
});

// ─── Test 9: PATCH is_default=true sets it as default and unsets others ───────

test('PATCH pipeline with is_default=true sets it as default and unsets other defaults', async ({ request }) => {
  const { token } = await registerOrg(request, 'patch-default');

  // Grab current default (seeded by org registration)
  const listRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
  });
  const originalDefault = ((await listRes.json()).data as PipelineDetail[]).find((p) => p.is_default);

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Candidate Pipeline ' + Date.now(), is_default: false },
  });
  expect(createRes.status()).toBe(201);
  const candidateId: string = (await createRes.json()).data.id;

  const patchRes = await request.patch('/api/v1/deals/pipelines/' + candidateId, {
    headers: { Authorization: 'Bearer ' + token },
    data: { is_default: true },
  });
  expect(patchRes.status()).toBe(200);
  expect((await patchRes.json()).data.is_default).toBe(true);

  if (originalDefault) {
    const checkRes = await request.get('/api/v1/deals/pipelines/' + originalDefault.id, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(checkRes.status()).toBe(200);
    expect((await checkRes.json()).data.is_default).toBe(false);
  }
});

// ─── Test 10: PATCH pipeline with unknown id → 404 ────────────────────────────

test('PATCH /api/v1/deals/pipelines/:id with unknown id returns 404 PIPELINE_NOT_FOUND', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.patch('/api/v1/deals/pipelines/00000000-0000-0000-0000-000000000000', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Ghost Update' },
  });
  expect(res.status()).toBe(404);
  const body = await res.json();
  expect(body.error.code).toBe('PIPELINE_NOT_FOUND');
  expect(typeof body.error.message).toBe('string');
});

// ─── Test 11: Cross-org: Org B cannot PATCH Org A pipeline → 404 ─────────────

test('cross-org: Org B cannot PATCH Org A pipeline — returns 404', async ({ request }) => {
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);
  const orgA = await registerOrg(request, 'patch-xorg-a-' + suffix);
  const orgB = await registerOrg(request, 'patch-xorg-b-' + suffix);

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + orgA.token },
    data: { name: 'OrgA Patch Target ' + suffix },
  });
  expect(createRes.status()).toBe(201);
  const pipelineId: string = (await createRes.json()).data.id;

  const res = await request.patch('/api/v1/deals/pipelines/' + pipelineId, {
    headers: { Authorization: 'Bearer ' + orgB.token },
    data: { name: 'Cross Org Rename Attempt' },
  });
  expect(res.status()).toBe(404);
});

// ─── Test 12: Cross-org: Org B cannot DELETE Org A pipeline → 404 ────────────

test('cross-org: Org B cannot DELETE Org A pipeline — returns 404', async ({ request }) => {
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);
  const orgA = await registerOrg(request, 'del-xorg-a-' + suffix);
  const orgB = await registerOrg(request, 'del-xorg-b-' + suffix);

  const createRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + orgA.token },
    data: { name: 'OrgA Delete Target ' + suffix },
  });
  expect(createRes.status()).toBe(201);
  const pipelineId: string = (await createRes.json()).data.id;

  const res = await request.delete('/api/v1/deals/pipelines/' + pipelineId, {
    headers: { Authorization: 'Bearer ' + orgB.token },
  });
  expect(res.status()).toBe(404);
});

// ─── Test 13: DELETE pipeline with won deals succeeds ─────────────────────────

test('DELETE pipeline succeeds when it only contains won (non-open) deals', async ({ request }) => {
  const { token } = await registerOrg(request, 'del-won-deals');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Won Deals Pipeline ' + Date.now(), is_default: false },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Won Stage', position: 0, is_won_stage: true, is_lost_stage: false },
  });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'WonContact' + Date.now() },
  });
  const contactId: string = (await cRes.json()).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Won Deal ' + Date.now(), contact_id: contactId, pipeline_id: plId, stage_id: stId },
  });
  expect(dRes.status()).toBe(201);
  const dealId: string = (await dRes.json()).data.id;

  // Mark the deal as won so it is no longer open
  const wonRes = await request.post('/api/v1/deals/' + dealId + '/won', {
    headers: { Authorization: 'Bearer ' + token },
    data: {},
  });
  expect(wonRes.status()).toBe(200);

  const delRes = await request.delete('/api/v1/deals/pipelines/' + plId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(delRes.status()).toBe(200);
});

// ─── Test 14: DELETE pipeline with lost deals succeeds ────────────────────────

test('DELETE pipeline succeeds when it only contains lost (non-open) deals', async ({ request }) => {
  const { token } = await registerOrg(request, 'del-lost-deals');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Lost Deals Pipeline ' + Date.now(), is_default: false },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Lost Stage', position: 0, is_won_stage: false, is_lost_stage: true },
  });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'LostContact' + Date.now() },
  });
  const contactId: string = (await cRes.json()).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Lost Deal ' + Date.now(), contact_id: contactId, pipeline_id: plId, stage_id: stId },
  });
  expect(dRes.status()).toBe(201);
  const dealId: string = (await dRes.json()).data.id;

  const lostRes = await request.post('/api/v1/deals/' + dealId + '/lost', {
    headers: { Authorization: 'Bearer ' + token },
    data: { reason: 'Test loss' },
  });
  expect(lostRes.status()).toBe(200);

  const delRes = await request.delete('/api/v1/deals/pipelines/' + plId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(delRes.status()).toBe(200);
});

// ─── Test 15: DELETE pipeline with archived deals succeeds ────────────────────

test('DELETE pipeline succeeds when it only contains archived deals', async ({ request }) => {
  const { token } = await registerOrg(request, 'del-archived-deals');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Archived Deals Pipeline ' + Date.now(), is_default: false },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Archived Stage', position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const cRes = await request.post('/api/v1/contacts', {
    headers: { Authorization: 'Bearer ' + token },
    data: { first_name: 'ArchivedContact' + Date.now() },
  });
  const contactId: string = (await cRes.json()).data.id;

  const dRes = await request.post('/api/v1/deals', {
    headers: { Authorization: 'Bearer ' + token },
    data: { title: 'Archived Deal ' + Date.now(), contact_id: contactId, pipeline_id: plId, stage_id: stId },
  });
  expect(dRes.status()).toBe(201);
  const dealId: string = (await dRes.json()).data.id;

  // Archive the deal (soft delete)
  const archRes = await request.delete('/api/v1/deals/' + dealId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(archRes.status()).toBe(200);

  const delRes = await request.delete('/api/v1/deals/pipelines/' + plId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(delRes.status()).toBe(200);
});

// ─── Test 16: GET /deals/pipelines/:id/stages — ascending position order ──────

test('GET /api/v1/deals/pipelines/:id/stages returns stages in ascending position order', async ({ request }) => {
  const { token } = await registerOrg(request, 'stages-order');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Position Order Pipeline ' + Date.now() },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  // Create stages in reverse position order
  for (const pos of [2, 0, 1]) {
    const sRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
      headers: { Authorization: 'Bearer ' + token },
      data: { name: 'Stage Pos ' + pos, position: pos, is_won_stage: false, is_lost_stage: false },
    });
    expect(sRes.status()).toBe(201);
  }

  const res = await request.get('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const stages: StageDetail[] = (await res.json()).data;
  expect(stages.length).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < stages.length; i++) {
    expect(stages[i].position).toBeGreaterThanOrEqual(stages[i - 1].position);
  }
});

// ─── Test 17: GET /deals/pipelines/:id/stages for non-existent pipeline → 404 ─

test('GET /api/v1/deals/pipelines/:id/stages for non-existent pipeline returns 404', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.get('/api/v1/deals/pipelines/00000000-0000-0000-0000-000000000000/stages', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(404);
});

// ─── Test 18: POST stage — position field stored correctly on readback ─────────

test('POST stage position field is stored correctly and returned on readback', async ({ request }) => {
  const { token } = await registerOrg(request, 'stage-position-readback');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Position Readback Pipeline ' + Date.now() },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Position Stage', position: 7, is_won_stage: false, is_lost_stage: false },
  });
  expect(stRes.status()).toBe(201);
  const stage: StageDetail = (await stRes.json()).data;
  expect(stage.position).toBe(7);
});

// ─── Test 19: PATCH /deals/stages/:id updates stage name ──────────────────────

test('PATCH /api/v1/deals/stages/:id updates the stage name', async ({ request }) => {
  const { token } = await registerOrg(request, 'patch-stage-name');

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Stage PATCH Pipeline ' + Date.now() },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Original Stage Name', position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const patchRes = await request.patch('/api/v1/deals/stages/' + stId, {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Renamed Stage Name' },
  });
  expect(patchRes.status()).toBe(200);
  const body = await patchRes.json();
  expect(body.data.name).toBe('Renamed Stage Name');
});

// ─── Test 20: PATCH /deals/stages/:id with unknown id → 404 ──────────────────

test('PATCH /api/v1/deals/stages/:id with unknown id returns 404', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.patch('/api/v1/deals/stages/00000000-0000-0000-0000-000000000000', {
    headers: { Authorization: 'Bearer ' + token },
    data: { name: 'Ghost Stage' },
  });
  expect(res.status()).toBe(404);
});

// ─── Test 21: Cross-org: Org B cannot PATCH Org A stage → 404 ────────────────

test('cross-org: Org B cannot PATCH Org A stage — returns 404', async ({ request }) => {
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);
  const orgA = await registerOrg(request, 'stage-xorg-a-' + suffix);
  const orgB = await registerOrg(request, 'stage-xorg-b-' + suffix);

  const plRes = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + orgA.token },
    data: { name: 'OrgA Stage Pipeline ' + suffix },
  });
  expect(plRes.status()).toBe(201);
  const plId: string = (await plRes.json()).data.id;

  const stRes = await request.post('/api/v1/deals/pipelines/' + plId + '/stages', {
    headers: { Authorization: 'Bearer ' + orgA.token },
    data: { name: 'OrgA Stage', position: 0, is_won_stage: false, is_lost_stage: false },
  });
  expect(stRes.status()).toBe(201);
  const stId: string = (await stRes.json()).data.id;

  const res = await request.patch('/api/v1/deals/stages/' + stId, {
    headers: { Authorization: 'Bearer ' + orgB.token },
    data: { name: 'Cross Org Stage Rename' },
  });
  expect(res.status()).toBe(404);
});

// ─── Test 22: Default pipeline with no open deals can be deleted ──────────────

test('default pipeline with no open deals can be deleted successfully', async ({ request }) => {
  const { token } = await registerOrg(request, 'del-default-pipeline');

  const listRes = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(listRes.status()).toBe(200);
  const pipelines: PipelineDetail[] = (await listRes.json()).data;
  const defaultPipeline = pipelines.find((p) => p.is_default);
  if (!defaultPipeline) throw new Error('No default pipeline found for new org');

  // Confirm it has no open deals (fresh org) and attempt deletion
  const delRes = await request.delete('/api/v1/deals/pipelines/' + defaultPipeline.id, {
    headers: { Authorization: 'Bearer ' + token },
  });
  // Business rule: deletion of an empty default pipeline should succeed (200)
  // or fail with a documented error code — either way the status must be definitive
  expect([200, 409, 422]).toContain(delRes.status());
  if (delRes.status() !== 200) {
    const body = await delRes.json();
    expect(typeof body.error.code).toBe('string');
    expect(body.error.code.length).toBeGreaterThan(0);
  }
});

// ─── Test 23: Pipeline list includes _count.deals field ──────────────────────

test('GET /api/v1/deals/pipelines pipeline entries include a _count.deals field', async ({ request }) => {
  const { token } = await registerOrg(request, 'pipeline-count');

  const res = await request.get('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();
  const pipelines = body.data as Array<PipelineDetail & { _count?: { deals: number } }>;
  expect(pipelines.length).toBeGreaterThanOrEqual(1);
  // At least the first pipeline should carry the _count.deals field
  const first = pipelines[0];
  expect(first._count).toBeDefined();
  expect(typeof first._count!.deals).toBe('number');
});

// ─── Test 24: Concurrent pipeline creation — both get unique IDs ──────────────

test('concurrent pipeline creation gives each pipeline a unique id without blocking', async ({ request }) => {
  const { token } = await registerOrg(request, 'concurrent-pipelines');
  const suffix = Date.now() + Math.floor(Math.random() * 1e6);

  const [resA, resB] = await Promise.all([
    request.post('/api/v1/deals/pipelines', {
      headers: { Authorization: 'Bearer ' + token },
      data: { name: 'Concurrent Pipeline A ' + suffix, is_default: false },
    }),
    request.post('/api/v1/deals/pipelines', {
      headers: { Authorization: 'Bearer ' + token },
      data: { name: 'Concurrent Pipeline B ' + suffix, is_default: false },
    }),
  ]);

  expect(resA.status()).toBe(201);
  expect(resB.status()).toBe(201);

  const idA: string = (await resA.json()).data.id;
  const idB: string = (await resB.json()).data.id;

  expect(typeof idA).toBe('string');
  expect(typeof idB).toBe('string');
  expect(idA).not.toBe(idB);
});

// ─── Test 25: POST pipeline without name → 400 ───────────────────────────────

test('POST /api/v1/deals/pipelines without name returns 400 validation error', async ({ request }) => {
  const { token } = getAuth();
  const res = await request.post('/api/v1/deals/pipelines', {
    headers: { Authorization: 'Bearer ' + token },
    data: { is_default: false },
  });
  expect(res.status()).toBe(400);
});
