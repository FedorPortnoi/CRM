import * as fs from 'fs';
import * as path from 'path';

interface AuthState {
  token: string;
  userId: string;
  email: string;
}

export function getAuth(): AuthState {
  const authPath = path.resolve(__dirname, '../.auth.json');
  return JSON.parse(fs.readFileSync(authPath, 'utf-8'));
}
