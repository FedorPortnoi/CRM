import { test, expect, APIRequestContext } from '@playwright/test';

type Auth = { token: string; userId: string };

async function registerOrg(request: APIRequestContext, suffix: string): Promise<Auth> {
  const unique = suffix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  const res = await request.post('/api/v1/auth/', {
    data: { email: unique + '@example.com', password: 'Password123!', name: 'User ' + suffix, org_name: 'Org ' + unique },
  });
  expect(res.status()).toBe(201);
  const body = await res.json() as { data: { token: string; user: { id: string } } };
  return { token: body.data.token, userId: body.data.user.id };
}
function authHeaders(token: string) { return { Authorization: 'Bearer ' + token }; }
function daysFromNow(days: number) { return new Date(Date.now() + days * 86400000).toISOString(); }
async function getPipeline(request: APIRequestContext, token: string) {
  const res = await request.get('/api/v1/deals/pipelines', { headers: authHeaders(token) });
  expect(res.status()).toBe(200);
  const body = await res.json() as { data: { id: string; is_default: boolean; stages: { id: string }[] }[] };
  return body.data.find(p => p.is_default) ?? body.data[0];
}
async function createContact(request: APIRequestContext, token: string, fn: string) {
  const res = await request.post('/api/v1/contacts', { headers: authHeaders(token), data: { first_name: fn } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data;
}
async function createDeal(request: APIRequestContext, token: string, title: string, cId: string, plId: string, stId: string) {
  const res = await request.post('/api/v1/deals', { headers: authHeaders(token), data: { title, contact_id: cId, pipeline_id: plId, stage_id: stId, currency: 'USD' } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}
async function createTask(request: APIRequestContext, token: string, userId: string, title: string) {
  const res = await request.post('/api/v1/tasks', { headers: authHeaders(token), data: { title, assigned_to: userId } });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { data: { id: string; status: string } }).data;
}

// ---- CONCURRENT STRESS ----

test("concurrent: 8 parallel contact creates all return 201 with unique IDs", async ({ request }) => {
  const org = await registerOrg(request, 'c27cc1');
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    request.post('/api/v1/contacts', { headers: authHeaders(org.token), data: { first_name: 'PC' + i } })));
  for (const r of rs) expect(r.status()).toBe(201);
  const ids = await Promise.all(rs.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
  expect(new Set(ids).size).toBe(8);
});
test("concurrent: 6 parallel task creates all return 201 with unique IDs", async ({ request }) => {
  const org = await registerOrg(request, 'c27ct1');
  const rs = await Promise.all(Array.from({ length: 6 }, (_, i) =>
    request.post('/api/v1/tasks', { headers: authHeaders(org.token), data: { title: 'PT' + i, assigned_to: org.userId } })));
  for (const r of rs) expect(r.status()).toBe(201);
  const ids = await Promise.all(rs.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
  expect(new Set(ids).size).toBe(6);
});
test("concurrent: 5 parallel calendar event creates all return 201", async ({ request }) => {
  const org = await registerOrg(request, 'c27ccal1');
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    request.post('/api/v1/calendar', { headers: authHeaders(org.token), data: { title: 'PE' + i, start_time: daysFromNow(i + 1), end_time: daysFromNow(i + 2) } })));
  for (const r of rs) expect(r.status()).toBe(201);
  const ids = await Promise.all(rs.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
  expect(new Set(ids).size).toBe(5);
});
test("concurrent: 5 parallel deal creates all return 201 with unique IDs", async ({ request }) => {
  const org = await registerOrg(request, 'c27cd1');
  const pl = await getPipeline(request, org.token);
  const c = await createContact(request, org.token, 'ConcDC');
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    request.post('/api/v1/deals', { headers: authHeaders(org.token), data: { title: 'PD' + i, contact_id: c.id, pipeline_id: pl.id, stage_id: pl.stages[0].id, currency: 'USD' } })));
  for (const r of rs) expect(r.status()).toBe(201);
  const ids = await Promise.all(rs.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
  expect(new Set(ids).size).toBe(5);
});
test("concurrent: 5 tasks completed in parallel all return 200", async ({ request }) => {
  const org = await registerOrg(request, 'c27ccomp1');
  const tasks = await Promise.all(Array.from({ length: 5 }, (_, i) => createTask(request, org.token, org.userId, 'CT' + i)));
  const rs = await Promise.all(tasks.map(t => request.post('/api/v1/tasks/' + t.id + '/complete', { headers: authHeaders(org.token) })));
  for (const r of rs) expect(r.status()).toBe(200);
});
test("concurrent: 7 parallel GET /contacts all return 200", async ({ request }) => {
  const org = await registerOrg(request, 'c27clist1');
  const rs = await Promise.all(Array.from({ length: 7 }, () => request.get('/api/v1/contacts', { headers: authHeaders(org.token) })));
  for (const r of rs) expect(r.status()).toBe(200);
});
test("concurrent: 5 parallel pipeline creates all return 201 with unique IDs", async ({ request }) => {
  const org = await registerOrg(request, 'c27cpl1');
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    request.post('/api/v1/deals/pipelines', { headers: authHeaders(org.token), data: { name: 'ConcPl' + i } })));
  for (const r of rs) expect(r.status()).toBe(201);
  const ids = await Promise.all(rs.map(async r => ((await r.json()) as { data: { id: string } }).data.id));
  expect(new Set(ids).size).toBe(5);
});
test("concurrent: 10 parallel contact list queries return same total", async ({ request }) => {
  const org = await registerOrg(request, 'c27cq1');
  await createContact(request, org.token, 'ConcQC');
  const rs = await Promise.all(Array.from({ length: 10 }, () => request.get('/api/v1/contacts', { headers: authHeaders(org.token) })));
  for (const r of rs) expect(r.status()).toBe(200);
  const totals = await Promise.all(rs.map(async r => ((await r.json()) as { meta: { total: number } }).meta.total));
  expect(new Set(totals).size).toBe(1);
});
// ---- CROSS-ORG ISOLATION ----

test("cross-org: org B cannot GET org A contact by ID", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA1");
  const orgB = await registerOrg(request, "c27cgB1");
  const c = await createContact(request, orgA.token, "IsoC1");
  const r = await request.get("/api/v1/contacts/" + c.id, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot PATCH org A contact", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA2");
  const orgB = await registerOrg(request, "c27cgB2");
  const c = await createContact(request, orgA.token, "IsoC2");
  const r = await request.patch("/api/v1/contacts/" + c.id, { headers: authHeaders(orgB.token), data: { first_name: "H" } });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot DELETE org A contact", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA3");
  const orgB = await registerOrg(request, "c27cgB3");
  const c = await createContact(request, orgA.token, "IsoC3");
  const r = await request.delete("/api/v1/contacts/" + c.id, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot GET org A deal by ID", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA4");
  const orgB = await registerOrg(request, "c27cgB4");
  const pl = await getPipeline(request, orgA.token);
  const c = await createContact(request, orgA.token, "IsoDC4");
  const d = await createDeal(request, orgA.token, "IsoD4", c.id, pl.id, pl.stages[0].id);
  const r = await request.get("/api/v1/deals/" + d.id, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot PATCH org A deal", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA5");
  const orgB = await registerOrg(request, "c27cgB5");
  const pl = await getPipeline(request, orgA.token);
  const c = await createContact(request, orgA.token, "IsoDC5");
  const d = await createDeal(request, orgA.token, "IsoD5", c.id, pl.id, pl.stages[0].id);
  const r = await request.patch("/api/v1/deals/" + d.id, { headers: authHeaders(orgB.token), data: { title: "H" } });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot mark org A deal as won", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA6");
  const orgB = await registerOrg(request, "c27cgB6");
  const pl = await getPipeline(request, orgA.token);
  const c = await createContact(request, orgA.token, "IsoDC6");
  const d = await createDeal(request, orgA.token, "IsoD6", c.id, pl.id, pl.stages[0].id);
  const r = await request.post("/api/v1/deals/" + d.id + "/won", { headers: authHeaders(orgB.token), data: {} });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot mark org A deal as lost", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA6b");
  const orgB = await registerOrg(request, "c27cgB6b");
  const pl = await getPipeline(request, orgA.token);
  const c = await createContact(request, orgA.token, "IsoDC6b");
  const d = await createDeal(request, orgA.token, "IsoD6b", c.id, pl.id, pl.stages[0].id);
  const r = await request.post("/api/v1/deals/" + d.id + "/lost", { headers: authHeaders(orgB.token), data: {} });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot GET org A task by ID", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA7");
  const orgB = await registerOrg(request, "c27cgB7");
  const t = await createTask(request, orgA.token, orgA.userId, "IsoT7");
  const r = await request.get("/api/v1/tasks/" + t.id, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot complete org A task", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA8");
  const orgB = await registerOrg(request, "c27cgB8");
  const t = await createTask(request, orgA.token, orgA.userId, "IsoT8");
  const r = await request.post("/api/v1/tasks/" + t.id + "/complete", { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot PATCH org A task", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA9");
  const orgB = await registerOrg(request, "c27cgB9");
  const t = await createTask(request, orgA.token, orgA.userId, "IsoT9");
  const r = await request.patch("/api/v1/tasks/" + t.id, { headers: authHeaders(orgB.token), data: { title: "H" } });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot GET org A pipeline by ID", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA10");
  const orgB = await registerOrg(request, "c27cgB10");
  const pl = await getPipeline(request, orgA.token);
  const r = await request.get("/api/v1/deals/pipelines/" + pl.id, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot delete org A pipeline", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA11");
  const orgB = await registerOrg(request, "c27cgB11");
  const plr = await request.post("/api/v1/deals/pipelines", { headers: authHeaders(orgA.token), data: { name: "IsoP11" } });
  const plId = ((await plr.json()) as { data: { id: string } }).data.id;
  const r = await request.delete("/api/v1/deals/pipelines/" + plId, { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B cannot list stages of org A pipeline", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA12");
  const orgB = await registerOrg(request, "c27cgB12");
  const pl = await getPipeline(request, orgA.token);
  const r = await request.get("/api/v1/deals/pipelines/" + pl.id + "/stages", { headers: authHeaders(orgB.token) });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B calendar events absent from org A list", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA13");
  const orgB = await registerOrg(request, "c27cgB13");
  const cr = await request.post("/api/v1/calendar", { headers: authHeaders(orgB.token), data: { title: "OrgBEvent", start_time: daysFromNow(1), end_time: daysFromNow(2) } });
  const eid = ((await cr.json()) as { data: { id: string } }).data.id;
  const lr = await request.get("/api/v1/calendar", { headers: authHeaders(orgA.token) });
  const body = await lr.json() as { data: { id: string }[] };
  expect(body.data.every(e => e.id !== eid)).toBe(true);
});

test("cross-org: org B cannot add stage to org A pipeline", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA14");
  const orgB = await registerOrg(request, "c27cgB14");
  const pl = await getPipeline(request, orgA.token);
  const r = await request.post("/api/v1/deals/pipelines/" + pl.id + "/stages", { headers: authHeaders(orgB.token), data: { name: "HS", position: 99, is_won_stage: false, is_lost_stage: false } });
  expect([403, 404]).toContain(r.status());
});

test("cross-org: org B deal list excludes org A deals", async ({ request }) => {
  const orgA = await registerOrg(request, "c27cgA15");
  const orgB = await registerOrg(request, "c27cgB15");
  const pl = await getPipeline(request, orgA.token);
  const c = await createContact(request, orgA.token, "IsoLC15");
  const d = await createDeal(request, orgA.token, "OrgAPriDeal", c.id, pl.id, pl.stages[0].id);
  const lr = await request.get("/api/v1/deals", { headers: authHeaders(orgB.token) });
  const body = await lr.json() as { data: { id: string }[] };
  expect(body.data.every(x => x.id !== d.id)).toBe(true);
});

// ---- DEAL STATE MACHINE ----

test("deal SM: open to won to re-won returns 422 DEAL_ALREADY_WON", async ({ request }) => {
  const org = await registerOrg(request, "c27smW1");
  const pl = await getPipeline(request, org.token);
  const c = await createContact(request, org.token, "SmWC1");
  const d = await createDeal(request, org.token, "SmWD1", c.id, pl.id, pl.stages[0].id);
  await request.post("/api/v1/deals/" + d.id + "/won", { headers: authHeaders(org.token), data: {} });
  const r = await request.post("/api/v1/deals/" + d.id + "/won", { headers: authHeaders(org.token), data: {} });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("DEAL_ALREADY_WON");
});

test("deal SM: open to lost to re-lost returns 422 DEAL_ALREADY_LOST", async ({ request }) => {
  const org = await registerOrg(request, "c27smL1");
  const pl = await getPipeline(request, org.token);
  const c = await createContact(request, org.token, "SmLC1");
  const d = await createDeal(request, org.token, "SmLD1", c.id, pl.id, pl.stages[0].id);
  await request.post("/api/v1/deals/" + d.id + "/lost", { headers: authHeaders(org.token), data: { reason: "P" } });
  const r = await request.post("/api/v1/deals/" + d.id + "/lost", { headers: authHeaders(org.token), data: {} });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("DEAL_ALREADY_LOST");
});

test("deal SM: won deal cannot be moved to stage returns 422 DEAL_NOT_OPEN", async ({ request }) => {
  const org = await registerOrg(request, "c27smWM1");
  const pl = await getPipeline(request, org.token);
  const c = await createContact(request, org.token, "SmWMC1");
  const d = await createDeal(request, org.token, "SmWMD1", c.id, pl.id, pl.stages[0].id);
  await request.post("/api/v1/deals/" + d.id + "/won", { headers: authHeaders(org.token), data: {} });
  const r = await request.patch("/api/v1/deals/" + d.id + "/stage", { headers: authHeaders(org.token), data: { stage_id: pl.stages[0].id } });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("DEAL_NOT_OPEN");
});

test("deal SM: archived deal cannot be moved to stage returns 422 DEAL_NOT_OPEN", async ({ request }) => {
  const org = await registerOrg(request, "c27smAM1");
  const pl = await getPipeline(request, org.token);
  const c = await createContact(request, org.token, "SmAMC1");
  const d = await createDeal(request, org.token, "SmAMD1", c.id, pl.id, pl.stages[0].id);
  await request.delete("/api/v1/deals/" + d.id, { headers: authHeaders(org.token) });
  const r = await request.patch("/api/v1/deals/" + d.id + "/stage", { headers: authHeaders(org.token), data: { stage_id: pl.stages[0].id } });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("DEAL_NOT_OPEN");
});

test("deal SM: re-archiving archived deal returns 422 DEAL_ALREADY_ARCHIVED", async ({ request }) => {
  const org = await registerOrg(request, "c27smRA1");
  const pl = await getPipeline(request, org.token);
  const c = await createContact(request, org.token, "SmRAC1");
  const d = await createDeal(request, org.token, "SmRAD1", c.id, pl.id, pl.stages[0].id);
  await request.delete("/api/v1/deals/" + d.id, { headers: authHeaders(org.token) });
  const r = await request.delete("/api/v1/deals/" + d.id, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("DEAL_ALREADY_ARCHIVED");
});

test("task SM: cancelled task cannot be started returns 422 INVALID_STATUS_TRANSITION", async ({ request }) => {
  const org = await registerOrg(request, "c27smTC1");
  const t = await createTask(request, org.token, org.userId, "SmTC1");
  await request.delete("/api/v1/tasks/" + t.id, { headers: authHeaders(org.token) });
  const r = await request.post("/api/v1/tasks/" + t.id + "/start", { headers: authHeaders(org.token) });
  expect(r.status()).toBe(422);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("INVALID_STATUS_TRANSITION");
});

test("task SM: pending to in_progress verified on GET", async ({ request }) => {
  const org = await registerOrg(request, "c27smTI1");
  const t = await createTask(request, org.token, org.userId, "SmTI1");
  await request.post("/api/v1/tasks/" + t.id + "/start", { headers: authHeaders(org.token) });
  const r = await request.get("/api/v1/tasks/" + t.id, { headers: authHeaders(org.token) });
  expect(r.status()).toBe(200);
  expect(((await r.json()) as { data: { status: string } }).data.status).toBe("in_progress");
});

test("task SM: re-completing done task returns 200 or 422", async ({ request }) => {
  const org = await registerOrg(request, "c27smTD1");
  const t = await createTask(request, org.token, org.userId, "SmTD1");
  await request.post("/api/v1/tasks/" + t.id + "/complete", { headers: authHeaders(org.token) });
  const r = await request.post("/api/v1/tasks/" + t.id + "/complete", { headers: authHeaders(org.token) });
  expect([200, 422]).toContain(r.status());
});
