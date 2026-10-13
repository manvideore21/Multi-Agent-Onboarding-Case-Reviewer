// Opens SQLite, enforces foreign keys, and applies database/schema.sql (and
// database/seed.sql when the database has no cases yet). Reuses the same SQL
// scripts as database/reset.sh, so there is one schema definition.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Db = Database.Database;

export interface OpenDatabaseOptions {
  schemaPath: string;
  seedPath?: string; // omit to skip seeding
}

export function openDatabase(filePath: string, options: OpenDatabaseOptions): Db {
  if (filePath !== ':memory:') fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');

  db.exec(fs.readFileSync(options.schemaPath, 'utf8')); // idempotent (IF NOT EXISTS)

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM onboarding_cases').get() as { n: number };
  if (n === 0 && options.seedPath) db.exec(fs.readFileSync(options.seedPath, 'utf8'));

  return db;
}
