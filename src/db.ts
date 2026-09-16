import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type InValue } from "@libsql/client";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "data.sqlite");

// En local (dev), on écrit dans un fichier SQLite classique — aucun compte requis.
// En production, TURSO_DATABASE_URL/TURSO_AUTH_TOKEN pointent vers une base Turso hébergée
// (même moteur SQLite, mais persistante et accessible depuis les fonctions serverless Vercel).
const url = process.env.TURSO_DATABASE_URL ?? `file:${DB_PATH}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

const client = createClient(authToken ? { url, authToken } : { url });

export async function queryAll<T>(sql: string, args: InValue[] = []): Promise<T[]> {
  const rs = await client.execute({ sql, args });
  return rs.rows as unknown as T[];
}

export async function queryOne<T>(sql: string, args: InValue[] = []): Promise<T | undefined> {
  const rows = await queryAll<T>(sql, args);
  return rows[0];
}

export async function run(sql: string, args: InValue[] = []): Promise<void> {
  await client.execute({ sql, args });
}

await client.executeMultiple(`
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    first_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    level TEXT,
    theme TEXT NOT NULL DEFAULT 'auto',
    onboarding_completed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS subjects (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    is_custom INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS user_subjects (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, subject_id)
  );

  CREATE TABLE IF NOT EXISTS courses (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    filename TEXT,
    storage_path TEXT,
    mime_type TEXT,
    subject_id TEXT REFERENCES subjects(id),
    chapter TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded',
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);

  CREATE TABLE IF NOT EXISTS course_photos (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_course_photos_course ON course_photos(course_id);

  CREATE TABLE IF NOT EXISTS revision_sheets (
    id TEXT PRIMARY KEY,
    course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sheets_user ON revision_sheets(user_id);
  CREATE INDEX IF NOT EXISTS idx_sheets_course ON revision_sheets(course_id);

  CREATE TABLE IF NOT EXISTS revision_sheet_sections (
    id TEXT PRIMARY KEY,
    sheet_id TEXT NOT NULL REFERENCES revision_sheets(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sections_sheet ON revision_sheet_sections(sheet_id);

  CREATE TABLE IF NOT EXISTS upload_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_upload_sessions_user ON upload_sessions(user_id);

  CREATE TABLE IF NOT EXISTS upload_session_photos (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
    storage_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    original_name TEXT,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_upload_session_photos_session ON upload_session_photos(session_id);
`);

const DEFAULT_SUBJECTS = [
  "Français",
  "Mathématiques",
  "Histoire-Géo",
  "Physique-Chimie",
  "SVT",
  "Anglais",
  "SES",
  "Espagnol",
  "Philosophie",
];

const subjectCount = await queryOne<{ count: number }>("SELECT COUNT(*) as count FROM subjects");
if (subjectCount?.count === 0) {
  for (const name of DEFAULT_SUBJECTS) {
    await run("INSERT INTO subjects (id, name, is_custom) VALUES (?, ?, 0)", [crypto.randomUUID(), name]);
  }
}

export interface DbUser {
  id: string;
  email: string;
  first_name: string;
  password_hash: string;
  level: string | null;
  theme: string;
  onboarding_completed: number;
  created_at: string;
}

export function getUserById(id: string): Promise<DbUser | undefined> {
  return queryOne<DbUser>("SELECT * FROM users WHERE id = ?", [id]);
}

export function getUserByEmail(email: string): Promise<DbUser | undefined> {
  return queryOne<DbUser>("SELECT * FROM users WHERE email = ?", [email]);
}

export function sanitizeUser(user: DbUser) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    level: user.level,
    theme: user.theme,
    onboardingCompleted: Boolean(user.onboarding_completed),
    createdAt: user.created_at,
  };
}
