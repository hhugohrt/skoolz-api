import { createHash, randomBytes } from "node:crypto";
import { v4 as uuid } from "uuid";
import { queryOne, run } from "../db.js";

export type AuthTokenType = "reset" | "verify" | "parent_pay";

const TTL_MS: Record<AuthTokenType, number> = {
  reset: 60 * 60 * 1000, // 1 h
  verify: 24 * 60 * 60 * 1000, // 24 h
  parent_pay: 7 * 24 * 60 * 60 * 1000, // 7 jours
};

// Seul le hash est stocké : une fuite de la base ne donne pas de liens utilisables.
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// Un seul lien valide par utilisateur et par type : en créer un nouveau invalide le précédent.
export async function createAuthToken(userId: string, type: AuthTokenType): Promise<string> {
  await run("DELETE FROM auth_tokens WHERE user_id = ? AND type = ?", [userId, type]);
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await run("INSERT INTO auth_tokens (id, user_id, type, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)", [
    uuid(),
    userId,
    type,
    hash(token),
    new Date(now.getTime() + TTL_MS[type]).toISOString(),
    now.toISOString(),
  ]);
  return token;
}

// Évite qu'on utilise le formulaire pour inonder la boîte mail de quelqu'un.
export async function createdRecently(userId: string, type: AuthTokenType, withinMs: number): Promise<boolean> {
  const row = await queryOne<{ created_at: string }>(
    "SELECT created_at FROM auth_tokens WHERE user_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1",
    [userId, type],
  );
  return row !== undefined && Date.now() - new Date(row.created_at).getTime() < withinMs;
}

// Usage unique : le jeton est supprimé dès qu'il est présenté, valide ou non.
export async function consumeAuthToken(token: string, type: AuthTokenType): Promise<string | null> {
  const row = await queryOne<{ id: string; user_id: string; expires_at: string }>(
    "SELECT id, user_id, expires_at FROM auth_tokens WHERE token_hash = ? AND type = ?",
    [hash(token), type],
  );
  if (!row) return null;
  await run("DELETE FROM auth_tokens WHERE id = ?", [row.id]);
  return new Date(row.expires_at).getTime() >= Date.now() ? row.user_id : null;
}

// Lecture sans consommer : le lien « demande à un parent » peut être ouvert plusieurs fois.
export async function peekAuthToken(token: string, type: AuthTokenType): Promise<string | null> {
  const row = await queryOne<{ user_id: string; expires_at: string }>(
    "SELECT user_id, expires_at FROM auth_tokens WHERE token_hash = ? AND type = ?",
    [hash(token), type],
  );
  return row && new Date(row.expires_at).getTime() >= Date.now() ? row.user_id : null;
}
