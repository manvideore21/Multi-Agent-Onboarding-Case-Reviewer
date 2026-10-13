// Runtime configuration from environment variables (optionally loaded from
// server/.env). Nothing here is secret or exposed to the frontend.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile();
} catch {
  // No .env file: defaults below apply.
}

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return value;
}

export const config = {
  port: intFromEnv('PORT', 4000),
  databasePath: path.resolve(process.cwd(), process.env.DATABASE_PATH ?? path.join(REPO_ROOT, 'database/onboarding.db')),
  maxAgentAttempts: intFromEnv('MAX_AGENT_ATTEMPTS', 2),
  schemaPath: path.join(REPO_ROOT, 'database/schema.sql'),
  seedPath: path.join(REPO_ROOT, 'database/seed.sql'),
};
