import { request } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export default async function globalSetup() {
  const api = await request.newContext({ baseURL: 'http://127.0.0.1:3000' });

  const email = `smoke-${Date.now()}@test.com`;
  const password = 'SmokeTest123!';

  const res = await api.post('/api/v1/auth/', {
    data: { email, password, name: 'Smoke Test', org_name: 'Smoke Org' },
  });

  if (!res.ok()) {
    const body = await res.text();
    throw new Error(`Register failed (${res.status()}): ${body}`);
  }

  const body = await res.json();
  const { token, user } = body.data;

  const authPath = path.resolve(__dirname, '../.auth.json');
  fs.writeFileSync(authPath, JSON.stringify({ token, userId: user.id, email }));

  await api.dispose();
}
